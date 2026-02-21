const pool = require('../db/pool');
const logger = require('../utils/logger');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const PRICING_LOCK_ID = 444555666;

// In-memory cache: normalizedModelId -> { promptCostPerToken, completionCostPerToken }
let pricingCache = new Map();

/**
 * Strip the "openrouter/" routing prefix from model IDs stored in sessions.
 * Sessions store model as "openrouter/moonshotai/kimi-k2.5"; OpenRouter's
 * model catalogue uses "moonshotai/kimi-k2.5" as the canonical ID.
 *
 * @param {string} modelId
 * @returns {string|null}
 */
function normalizeModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  if (modelId.startsWith('openrouter/')) {
    return modelId.slice('openrouter/'.length);
  }
  return modelId;
}

/**
 * Load pricing rows from the DB into the in-memory cache.
 * Called on startup (before the first network sync) so cost estimation works
 * immediately even if OpenRouter is temporarily unreachable.
 *
 * @returns {Promise<number>} Number of models loaded
 */
async function loadPricingCache() {
  const result = await pool.query(
    'SELECT model_id, prompt_cost_per_token, completion_cost_per_token FROM model_pricing'
  );
  const next = new Map();
  for (const row of result.rows) {
    next.set(row.model_id, {
      promptCostPerToken: parseFloat(row.prompt_cost_per_token) || 0,
      completionCostPerToken: parseFloat(row.completion_cost_per_token) || 0,
    });
  }
  pricingCache = next;
  return next.size;
}

/**
 * Fetch the full model list from OpenRouter, persist pricing to DB, and
 * refresh the in-memory cache.  Uses a Postgres advisory lock so only one
 * API instance runs the sync at a time.
 *
 * Requires Node 18+ for the built-in fetch API.
 *
 * @returns {Promise<number>} Number of model rows upserted
 */
async function syncPricingFromOpenRouter() {
  const client = await pool.connect();
  try {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [PRICING_LOCK_ID]
    );
    if (!lockResult.rows[0].acquired) {
      logger.info('Model pricing sync already running on another instance, skipping');
      return 0;
    }

    logger.info('Fetching model pricing from OpenRouter');

    const headers = { Accept: 'application/json' };
    if (process.env.OPENROUTER_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    }

    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models API responded with HTTP ${response.status}`);
    }

    const data = await response.json();
    const models = data?.data || [];

    if (models.length === 0) {
      logger.warn('OpenRouter models API returned an empty model list');
      await client.query('SELECT pg_advisory_unlock($1)', [PRICING_LOCK_ID]);
      return 0;
    }

    let upserted = 0;
    for (const model of models) {
      if (!model.id) continue;
      const pricing = model.pricing || {};
      await client.query(
        `INSERT INTO model_pricing
           (model_id, model_name, prompt_cost_per_token, completion_cost_per_token, context_length, synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (model_id) DO UPDATE SET
           model_name                = EXCLUDED.model_name,
           prompt_cost_per_token     = EXCLUDED.prompt_cost_per_token,
           completion_cost_per_token = EXCLUDED.completion_cost_per_token,
           context_length            = EXCLUDED.context_length,
           synced_at                 = NOW()`,
        [
          model.id,
          model.name || null,
          parseFloat(pricing.prompt) || 0,
          parseFloat(pricing.completion) || 0,
          model.context_length || null,
        ]
      );
      upserted++;
    }

    await client.query('SELECT pg_advisory_unlock($1)', [PRICING_LOCK_ID]);

    // Rebuild the in-memory cache from the freshly written DB rows
    await loadPricingCache();

    logger.info('Model pricing synced from OpenRouter', { modelsUpserted: upserted });
    return upserted;
  } catch (error) {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [PRICING_LOCK_ID]);
    } catch (_) { /* best-effort unlock */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Estimate the USD cost for a session based on cached OpenRouter pricing.
 * Returns null when no pricing data is available for the given model so that
 * callers can preserve an explicit zero rather than showing a misleading value.
 *
 * Cache read tokens are priced at 10% of the prompt price (standard discount
 * across OpenRouter / Anthropic / OpenAI providers). Cache write tokens are
 * priced at 125% of the prompt price (Anthropic convention; other providers
 * may vary but this is a reasonable default).
 *
 * @param {string|null} modelId  Session model ID (may include "openrouter/" prefix)
 * @param {number} inputTokens   Non-cached input tokens
 * @param {number} outputTokens
 * @param {object} [opts]
 * @param {number} [opts.cacheReadTokens=0]  Tokens served from provider cache
 * @param {number} [opts.cacheWriteTokens=0] Tokens written to provider cache
 * @returns {number|null}
 */
function estimateCostFromTokens(modelId, inputTokens, outputTokens, opts = {}) {
  if (!modelId) return null;
  const normalizedId = normalizeModelId(modelId);
  const pricing = pricingCache.get(normalizedId);
  if (!pricing) return null;

  const cacheReadTokens = opts.cacheReadTokens || 0;
  const cacheWriteTokens = opts.cacheWriteTokens || 0;

  const cost =
    (inputTokens || 0) * pricing.promptCostPerToken +
    (outputTokens || 0) * pricing.completionCostPerToken +
    cacheReadTokens * pricing.promptCostPerToken * 0.1 +
    cacheWriteTokens * pricing.promptCostPerToken * 1.25;

  return cost > 0 ? cost : null;
}

/**
 * Start the weekly model pricing refresh background job.
 *
 * On startup:
 *   1. Load any existing pricing from the DB into the in-memory cache (fast, no
 *      network) so cost estimation works even if OpenRouter is unreachable.
 *   2. Kick off an async sync from OpenRouter.
 *
 * Then repeats the sync every `intervalMs` (default: 7 days).
 *
 * Errors are logged and swallowed so this job never crashes the process.
 *
 * @param {number} [intervalMs]
 * @returns {{ stop: () => void }}
 */
function startPricingRefreshJob(intervalMs = 7 * 24 * 60 * 60 * 1000) {
  // Load from DB first so the cache is warm before the first network call
  loadPricingCache()
    .then((count) => {
      if (count > 0) {
        logger.info('Model pricing cache loaded from DB', { models: count });
      }
    })
    .catch((err) => {
      if (err.code !== 'SERVICE_NOT_CONFIGURED') {
        logger.warn('Model pricing: initial DB cache load failed', { error: err.message });
      }
    });

  async function tick() {
    try {
      await syncPricingFromOpenRouter();
    } catch (err) {
      logger.warn('Model pricing sync failed', { error: err.message });
    }
  }

  tick();
  const handle = setInterval(tick, intervalMs);

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

module.exports = {
  normalizeModelId,
  loadPricingCache,
  syncPricingFromOpenRouter,
  estimateCostFromTokens,
  startPricingRefreshJob,
};
