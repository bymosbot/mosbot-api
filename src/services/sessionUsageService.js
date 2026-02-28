const pool = require('../db/pool');
const { gatewayWsRpc } = require('./openclawGatewayClient');
const logger = require('../utils/logger');

/**
 * Derive agent_key from session key.
 * Session key format: "main" or "agent:<agentId>:<kind>[:<uuid>]"
 *
 * @param {string} key
 * @returns {string}
 */
function deriveAgentKeyFromSessionKey(key) {
  if (!key || typeof key !== 'string') return 'main';
  const parts = key.split(':');
  if (parts[0] === 'agent' && parts.length >= 2) return parts[1];
  return 'main';
}

/**
 * Extract and normalize model string from a session object.
 * Handles modelProvider+model, model, or agentKey (when used as model hint).
 * Normalizes model names to ensure consistency (e.g., prevents duplicate prefixes).
 *
 * @param {object} s
 * @returns {string|null}
 */
function extractModel(s) {
  if (!s.model || typeof s.model !== 'string') {
    return null;
  }

  let model = s.model.trim();
  if (!model) {
    return null;
  }

  // Normalize double prefixes first (e.g., "openrouter/openrouter/..." -> "openrouter/...")
  // This handles cases where the model already has a provider prefix duplicated
  const doublePrefixMatch = model.match(/^([^/]+)\/\1\/(.+)$/);
  if (doublePrefixMatch) {
    const [, prefix, rest] = doublePrefixMatch;
    model = `${prefix}/${rest}`;
  }

  // If modelProvider is provided, construct the full model name
  if (s.modelProvider && s.modelProvider.trim()) {
    const provider = s.modelProvider.trim();

    // Check if model already starts with the provider prefix to avoid duplication
    // e.g., if modelProvider="openrouter" and model="openrouter/moonshotai/kimi-k2.5"
    if (model.startsWith(`${provider}/`)) {
      return model; // Already has the prefix, return as-is
    }

    // Check if model already starts with any provider prefix
    // e.g., if modelProvider="openrouter" but model="moonshotai/kimi-k2.5"
    // In this case, we still prepend the provider since it's the authoritative source
    return `${provider}/${model}`;
  }

  // No modelProvider, return model as-is (may already be fully qualified or not)
  return model;
}

/**
 * Extract the cron job UUID from a session key.
 * Session key format for cron runs:
 *   "agent:<agentId>:cron:<jobId>:run:<sessionId>"
 * Returns null for all other session kinds (main, subagent, hook, etc.).
 *
 * @param {string} key
 * @returns {string|null}
 */
function deriveJobIdFromSessionKey(key) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.split(':');
  // agent : agentId : cron : jobId : run : sessionId
  //   0       1        2      3       4       5
  if (parts[0] === 'agent' && parts[2] === 'cron' && parts.length >= 4) {
    return parts[3] || null;
  }
  return null;
}

/**
 * Truncate a timestamp down to the start of its UTC hour.
 *
 * @param {Date} date
 * @returns {Date}
 */
function toHourBucket(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Upsert a batch of session usage records.
 *
 * Writes to two tables:
 *   1. session_usage          — latest cumulative totals per session (snapshot)
 *   2. session_usage_hourly   — incremental deltas per session per hour bucket
 *
 * Each row in `sessions` is expected to have the shape returned by the
 * Gateway's sessions.usage RPC:
 *   { key: string, usage: { totalCost, input, output, cacheRead, cacheWrite } }
 * Optional: agentKey or agent_key, model or modelProvider+model (for per-row agent/model).
 *
 * The Gateway always returns cumulative totals for the session lifetime.
 * Deltas are computed by comparing incoming values against the previous
 * cumulative stored in session_usage, then accumulated into the current
 * hour bucket in session_usage_hourly.
 *
 * @param {Array<{ key: string, usage: object, agentKey?: string, agent_key?: string, model?: string, modelProvider?: string, jobId?: string, job_id?: string }>} sessions
 */
async function upsertSessionUsageBatch(sessions) {
  if (!sessions || sessions.length === 0) return;

  const hourBucket = toHourBucket(new Date());
  const sessionKeys = sessions.map((s) => s.key).filter(Boolean);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Batch-read previous cumulative values so we can compute deltas.
    const prevResult = await client.query(
      'SELECT session_key, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd FROM session_usage WHERE session_key = ANY($1)',
      [sessionKeys],
    );
    const prevByKey = new Map();
    for (const row of prevResult.rows) {
      prevByKey.set(row.session_key, row);
    }

    for (const s of sessions) {
      if (!s.key) continue;

      const u = s.usage || {};
      const agentKey = s.agentKey ?? s.agent_key ?? deriveAgentKeyFromSessionKey(s.key);
      const model = extractModel(s);
      const jobId = s.job_id ?? s.jobId ?? deriveJobIdFromSessionKey(s.key);
      const label = s.label ?? s.sessionLabel ?? null;

      const newInput = u.input || 0;
      const newOutput = u.output || 0;
      const newCacheRead = u.cacheRead || 0;
      const newCacheWrite = u.cacheWrite || 0;
      const newCost = u.totalCost || 0;

      // Upsert cumulative snapshot into session_usage
      await client.query(
        `INSERT INTO session_usage
           (session_key, agent_key, model, job_id, label, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd, last_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (session_key) DO UPDATE SET
           agent_key          = COALESCE(EXCLUDED.agent_key, session_usage.agent_key),
           model              = COALESCE(EXCLUDED.model, session_usage.model),
           job_id             = COALESCE(EXCLUDED.job_id, session_usage.job_id),
           label              = COALESCE(EXCLUDED.label, session_usage.label),
           tokens_input       = EXCLUDED.tokens_input,
           tokens_output      = EXCLUDED.tokens_output,
           tokens_cache_read  = EXCLUDED.tokens_cache_read,
           tokens_cache_write = EXCLUDED.tokens_cache_write,
           cost_usd           = EXCLUDED.cost_usd,
           last_updated_at    = NOW()`,
        [
          s.key,
          agentKey,
          model,
          jobId,
          label,
          newInput,
          newOutput,
          newCacheRead,
          newCacheWrite,
          newCost,
        ],
      );

      // Compute deltas against previous cumulative (clamp to 0 to handle resets)
      const prev = prevByKey.get(s.key);
      const deltaInput = Math.max(0, newInput - (prev ? Number(prev.tokens_input) : 0));
      const deltaOutput = Math.max(0, newOutput - (prev ? Number(prev.tokens_output) : 0));
      const deltaCacheRead = Math.max(
        0,
        newCacheRead - (prev ? Number(prev.tokens_cache_read) : 0),
      );
      const deltaCacheWrite = Math.max(
        0,
        newCacheWrite - (prev ? Number(prev.tokens_cache_write) : 0),
      );
      const deltaCost = Math.max(0, newCost - (prev ? Number(prev.cost_usd) : 0));

      // Skip if there is nothing new to record
      if (
        deltaInput === 0 &&
        deltaOutput === 0 &&
        deltaCacheRead === 0 &&
        deltaCacheWrite === 0 &&
        deltaCost === 0
      ) {
        continue;
      }

      // Accumulate deltas into the current hour bucket in session_usage_hourly
      await client.query(
        `INSERT INTO session_usage_hourly
           (session_key, agent_key, model, job_id, hour_bucket, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (session_key, hour_bucket) DO UPDATE SET
           agent_key          = COALESCE(EXCLUDED.agent_key, session_usage_hourly.agent_key),
           model              = COALESCE(EXCLUDED.model, session_usage_hourly.model),
           job_id             = COALESCE(EXCLUDED.job_id, session_usage_hourly.job_id),
           tokens_input       = session_usage_hourly.tokens_input       + EXCLUDED.tokens_input,
           tokens_output      = session_usage_hourly.tokens_output      + EXCLUDED.tokens_output,
           tokens_cache_read  = session_usage_hourly.tokens_cache_read  + EXCLUDED.tokens_cache_read,
           tokens_cache_write = session_usage_hourly.tokens_cache_write + EXCLUDED.tokens_cache_write,
           cost_usd           = session_usage_hourly.cost_usd           + EXCLUDED.cost_usd`,
        [
          s.key,
          agentKey,
          model,
          jobId,
          hourBucket,
          deltaInput,
          deltaOutput,
          deltaCacheRead,
          deltaCacheWrite,
          deltaCost,
        ],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch today's session usage from the Gateway and persist it to session_usage.
 * Intended to be called by the background poller and the GET /sessions endpoint.
 */
async function syncSessionUsageFromGateway() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await gatewayWsRpc('sessions.usage', {
    startDate: today,
    endDate: today,
    limit: 1000,
  });

  const sessions = result?.sessions || [];
  if (sessions.length === 0) return 0;

  await upsertSessionUsageBatch(sessions);
  return sessions.length;
}

/**
 * Start a background interval that syncs session usage from the Gateway every
 * `intervalMs` milliseconds. Runs immediately on first tick, then on a fixed interval.
 *
 * Errors are logged and swallowed so the poller never crashes the process.
 *
 * @param {number} intervalMs  Poll interval in milliseconds (default: 60 000)
 * @returns {{ stop: () => void }}  Handle to stop the poller
 */
function startSessionUsagePoller(intervalMs = 60_000) {
  async function tick() {
    try {
      const count = await syncSessionUsageFromGateway();
      if (count > 0) {
        logger.debug('Session usage poller: synced records', { count });
      }
    } catch (err) {
      if (err.code === 'SERVICE_NOT_CONFIGURED') {
        // Gateway not configured in this environment — expected in local dev
        return;
      }
      logger.warn('Session usage poller: sync failed', { error: err.message });
    }
  }

  // Run immediately, then on interval
  tick();
  const handle = setInterval(tick, intervalMs);

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

module.exports = {
  upsertSessionUsageBatch,
  syncSessionUsageFromGateway,
  startSessionUsagePoller,
};
