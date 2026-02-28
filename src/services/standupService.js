const pool = require('../db/pool');
const logger = require('../utils/logger');
const { recordActivityLogEventSafe } = require('./activityLogService');

// Canonical standup order: COO > CTO > CPO > CMO
const STANDUP_AGENT_ORDER = ['coo', 'cto', 'cpo', 'cmo'];

/**
 * Fetch agent users from DB in standup order (COO > CTO > CPO > CMO)
 * Only returns active users with a recognised agent_id
 * @returns {Promise<Array>} Array of user rows
 */
async function getAgentUsersForStandup() {
  try {
    const result = await pool.query(
      `SELECT id AS user_id, name, agent_id, avatar_url
       FROM users
       WHERE agent_id = ANY($1::text[])
         AND active = true
       ORDER BY ARRAY_POSITION($1::text[], agent_id)`,
      [STANDUP_AGENT_ORDER],
    );
    return result.rows;
  } catch (error) {
    logger.error('Failed to fetch agent users for standup', { error: error.message });
    return [];
  }
}

/**
 * Send message to agent and wait for reply using OpenClaw Gateway sessions_send
 * @param {string} agentId - OpenClaw agent ID (e.g. 'coo')
 * @param {string} message
 * @param {number} timeoutSeconds
 * @returns {Promise<string|null>}
 */
async function sendMessageToAgent(agentId, message, timeoutSeconds = 120) {
  const sessionKey = `agent:${agentId}:main`;
  try {
    const { invokeTool } = require('./openclawGatewayClient');

    const result = await invokeTool(
      'sessions_send',
      {
        sessionKey,
        message,
        timeoutSeconds,
      },
      {
        sessionKey: 'main',
      },
    );

    if (!result) {
      logger.warn('sessions_send returned null', { agentId });
      recordActivityLogEventSafe({
        event_type: 'adhoc_request',
        source: 'standup',
        title: `Standup message sent to ${agentId}`,
        description: message.slice(0, 200),
        severity: 'warning',
        agent_id: agentId,
        session_key: sessionKey,
        meta: { outcome: 'null_result', timeoutSeconds },
      });
      return null;
    }

    if (result.status === 'ok' && result.reply) {
      recordActivityLogEventSafe({
        event_type: 'adhoc_request',
        source: 'standup',
        title: `Standup message sent to ${agentId}`,
        description: message.slice(0, 200),
        severity: 'info',
        agent_id: agentId,
        session_key: sessionKey,
        run_id: result.runId || null,
        meta: { outcome: 'ok', reply_preview: result.reply.slice(0, 300), timeoutSeconds },
      });
      return result.reply;
    }

    if (result.status === 'timeout') {
      logger.warn('Agent response timed out', { agentId, runId: result.runId });
      recordActivityLogEventSafe({
        event_type: 'adhoc_request',
        source: 'standup',
        title: `Standup message to ${agentId} timed out`,
        description: message.slice(0, 200),
        severity: 'warning',
        agent_id: agentId,
        session_key: sessionKey,
        run_id: result.runId || null,
        meta: { outcome: 'timeout', timeoutSeconds },
      });
      return `[Timeout after ${timeoutSeconds}s — no response]`;
    }

    if (result.status === 'error') {
      logger.error('Agent response error', { agentId, error: result.error });
      recordActivityLogEventSafe({
        event_type: 'adhoc_request',
        source: 'standup',
        title: `Standup message to ${agentId} errored`,
        description: message.slice(0, 200),
        severity: 'error',
        agent_id: agentId,
        session_key: sessionKey,
        run_id: result.runId || null,
        meta: { outcome: 'error', error: result.error, timeoutSeconds },
      });
      return `[Error: ${result.error}]`;
    }

    logger.warn('Unexpected sessions_send result', { agentId, result });
    return null;
  } catch (error) {
    logger.error('Failed to send message to agent', {
      agentId,
      error: error.message,
      code: error.code,
    });

    recordActivityLogEventSafe({
      event_type: 'adhoc_request',
      source: 'standup',
      title: `Standup message to ${agentId} failed`,
      description: message.slice(0, 200),
      severity: 'error',
      agent_id: agentId,
      session_key: sessionKey,
      meta: { outcome: 'exception', error: error.message, code: error.code, timeoutSeconds },
    });

    if (error.status === 404 || error.code === 'TOOL_NOT_AVAILABLE') {
      logger.error('sessions_send not available — enable gateway.tools.allow in OpenClaw config');
      return '[Error: sessions_send tool not available. Enable gateway.tools.allow in OpenClaw config]';
    }

    return null;
  }
}

/**
 * Parse agent standup response into structured sections
 * Expected format:
 *   Yesterday: …
 *   Today: …
 *   Blockers: …
 */
function parseStandupResponse(response) {
  const parsed = {
    yesterday: null,
    today: null,
    blockers: null,
    tasks: null,
    raw: response,
  };

  if (!response) return parsed;

  const yesterdayMatch = response.match(
    /Yesterday:?\s*([^\n]+(?:\n(?!Today:|Blockers:|Tasks:).+)*)/i,
  );
  const todayMatch = response.match(/Today:?\s*([^\n]+(?:\n(?!Yesterday:|Blockers:|Tasks:).+)*)/i);
  const blockersMatch = response.match(
    /Blockers:?\s*([^\n]+(?:\n(?!Yesterday:|Today:|Tasks:).+)*)/i,
  );
  const tasksMatch = response.match(/Tasks:?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])/i);

  if (yesterdayMatch) parsed.yesterday = yesterdayMatch[1].trim();
  if (todayMatch) parsed.today = todayMatch[1].trim();
  if (blockersMatch) parsed.blockers = blockersMatch[1].trim();

  if (tasksMatch) {
    try {
      parsed.tasks = JSON.parse(tasksMatch[1]);
    } catch {
      logger.warn('Failed to parse tasks JSON from standup response');
    }
  }

  // Fallback: store raw in today when no sections detected
  if (!parsed.yesterday && !parsed.today && !parsed.blockers) {
    parsed.today = response.trim();
  }

  return parsed;
}

/**
 * Create (or reset) today's standup record
 */
async function createOrGetStandup(standupDate, timezone) {
  const title = `Executive Standup — ${standupDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  })}`;

  const result = await pool.query(
    `INSERT INTO standups (standup_date, title, timezone, status, started_at)
     VALUES ($1, $2, $3, 'running', NOW())
     ON CONFLICT (standup_date)
     DO UPDATE SET started_at = EXCLUDED.started_at, status = 'running'
     RETURNING *`,
    [standupDate.toISOString().split('T')[0], title, timezone],
  );

  return result.rows[0];
}

/**
 * Collect standup responses from all agents and persist entries/messages.
 * Idempotent: clears any existing entries/messages for the standup before
 * writing fresh rows within a single transaction.
 *
 * @param {object} standup - Standup row from the database
 * @returns {Promise<{status: string, agentCount?: number, message?: string}>}
 */
async function runStandupById(standup) {
  const startTime = Date.now();
  const standupId = standup.id;

  logger.info('Running standup collection', { standupId });

  const agents = await getAgentUsersForStandup();

  if (agents.length === 0) {
    logger.warn('No agent users found for standup', { standupId });
    await pool.query("UPDATE standups SET status = 'error', completed_at = NOW() WHERE id = $1", [
      standupId,
    ]);
    return { status: 'error', message: 'No agent users found in the database', standupId };
  }

  logger.info(`Collecting standup from ${agents.length} agents`, {
    standupId,
    agents: agents.map((a) => a.agent_id),
  });

  // Mark standup as running before collection begins
  await pool.query("UPDATE standups SET status = 'running', started_at = NOW() WHERE id = $1", [
    standupId,
  ]);

  // Collect all agent responses first, then persist atomically
  const collectedResponses = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const turnOrder = i + 1;

    logger.info(`Agent ${turnOrder}/${agents.length}: ${agent.agent_id}`, { standupId });

    const prompt = `Please provide your daily standup report in the following format:

Yesterday: What you worked on yesterday
Today: What you plan to work on today
Blockers: Any blockers or issues to raise

Keep each section concise (2–3 sentences). Optionally add structured tasks:
Tasks: [{"id": "TASK-123", "title": "...", "status": "..."}]`;

    const response = await sendMessageToAgent(agent.agent_id, prompt, 90);
    const content = response || '[No response received]';

    collectedResponses.push({
      agent,
      turnOrder,
      content,
      parsed: parseStandupResponse(content),
    });

    logger.info('Agent response collected', { standupId, agentId: agent.agent_id });
  }

  // Persist all collected responses in a single transaction, clearing existing rows first
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing entries and messages so re-runs are idempotent
    await client.query('DELETE FROM standup_entries WHERE standup_id = $1', [standupId]);
    await client.query('DELETE FROM standup_messages WHERE standup_id = $1', [standupId]);

    for (const { agent, turnOrder, content, parsed } of collectedResponses) {
      await client.query(
        `INSERT INTO standup_messages (standup_id, kind, agent_id, content)
         VALUES ($1, 'agent', $2, $3)`,
        [standupId, agent.agent_id, content],
      );

      await client.query(
        `INSERT INTO standup_entries (
           standup_id, user_id, agent_id, turn_order,
           yesterday, today, blockers, tasks, raw
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          standupId,
          agent.user_id,
          agent.agent_id,
          turnOrder,
          parsed.yesterday,
          parsed.today,
          parsed.blockers,
          parsed.tasks ? JSON.stringify(parsed.tasks) : null,
          parsed.raw,
        ],
      );
    }

    await client.query(
      "UPDATE standups SET status = 'completed', completed_at = NOW() WHERE id = $1",
      [standupId],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Transaction failed during standup run, rolling back', {
      standupId,
      error: error.message,
    });

    await pool.query("UPDATE standups SET status = 'error', completed_at = NOW() WHERE id = $1", [
      standupId,
    ]);

    return { status: 'error', message: error.message, durationMs: Date.now() - startTime };
  } finally {
    client.release();
  }

  const durationMs = Date.now() - startTime;
  logger.info('Standup run completed', { standupId, agentCount: agents.length, durationMs });

  return { status: 'completed', standupId, agentCount: agents.length, durationMs };
}

/**
 * Main entry point — orchestrates daily standup generation (cron-triggered).
 * Creates or resets today's standup record, then delegates to runStandupById.
 */
async function generateDailyStandup(timezone = 'UTC') {
  const startTime = Date.now();

  logger.info('Starting daily standup generation', { timezone });

  try {
    const now = new Date();
    const standupDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

    const standup = await createOrGetStandup(standupDate, timezone);
    logger.info('Standup record ready', { standupId: standup.id, date: standup.standup_date });

    const result = await runStandupById(standup);

    return {
      ...result,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Failed to generate daily standup', { error: error.message, stack: error.stack });

    // Best-effort: mark today's running standup as error
    try {
      const result = await pool.query(
        "SELECT id FROM standups WHERE standup_date = CURRENT_DATE AND status = 'running' LIMIT 1",
      );
      if (result.rows.length > 0) {
        await pool.query(
          "UPDATE standups SET status = 'error', completed_at = NOW() WHERE id = $1",
          [result.rows[0].id],
        );
      }
    } catch (cleanupErr) {
      logger.error('Failed to mark standup as error', { error: cleanupErr.message });
    }

    return { status: 'error', message: error.message, durationMs: Date.now() - startTime };
  }
}

module.exports = {
  generateDailyStandup,
  runStandupById,
  getAgentUsersForStandup,
  sendMessageToAgent,
  parseStandupResponse,
};
