/**
 * activityLogService.js
 *
 * Shared helper for writing structured events into the activity_logs table.
 * Import this wherever you need to record an activity event.
 *
 * Usage:
 *   const { recordActivityLogEvent } = require('../services/activityLogService');
 *   await recordActivityLogEvent({
 *     event_type: 'workspace_file_created',
 *     source: 'workspace',
 *     title: 'File created: /shared/projects/foo/plan.md',
 *     description: 'Agent coo created a new file in the workspace.',
 *     agent_id: 'coo',
 *     workspace_path: '/shared/projects/foo/plan.md',
 *     meta: { size: 1024 },
 *   });
 */

const pool = require('../db/pool');

const VALID_EVENT_TYPES = new Set([
  'task_executed',
  'cron_run',
  'heartbeat_run',
  'heartbeat_attention',
  'adhoc_request',
  'subagent_request',
  'subagent_completed',
  'workspace_file_created',
  'workspace_file_updated',
  'workspace_file_deleted',
  'org_chart_agent_updated',
  'org_chart_agent_created',
  'cron_job_created',
  'cron_job_updated',
  'cron_job_deleted',
  'cron_job_triggered',
  'openclaw_config_updated',
  'legacy',
  'system',
]);

const VALID_SEVERITIES = new Set(['info', 'warning', 'attention', 'error']);

const VALID_SOURCES = new Set([
  'task',
  'cron',
  'heartbeat',
  'subagent',
  'workspace',
  'org',
  'standup',
  'system',
]);

/**
 * Insert a single event into activity_logs.
 * Returns the inserted row, or null if the row was deduplicated.
 *
 * @param {object} opts
 * @param {string}  opts.event_type      - One of VALID_EVENT_TYPES
 * @param {string}  opts.source          - One of VALID_SOURCES
 * @param {string}  opts.title           - Short human-readable title (max 500 chars)
 * @param {string}  opts.description     - Longer description
 * @param {string}  [opts.severity]      - 'info' | 'warning' | 'attention' | 'error'
 * @param {string}  [opts.agent_id]      - OpenClaw agent id
 * @param {string}  [opts.task_id]       - UUID of related task
 * @param {string}  [opts.job_id]        - Cron job id
 * @param {string}  [opts.session_key]   - OpenClaw session key
 * @param {string}  [opts.run_id]        - Run sub-key
 * @param {string}  [opts.workspace_path]- Workspace file path
 * @param {object}  [opts.meta]          - Arbitrary JSON payload
 * @param {string}  [opts.dedupe_key]    - Idempotency key; duplicate inserts are silently dropped
 * @param {string}  [opts.actor_user_id] - UUID of the human user who triggered the event
 * @param {string}  [opts.category]      - Legacy category field (optional)
 * @param {Date}    [opts.timestamp]     - Override event timestamp (defaults to now)
 * @returns {Promise<object|null>}
 */
async function recordActivityLogEvent(opts) {
  const {
    event_type,
    source,
    title,
    description = '',
    severity = 'info',
    agent_id = null,
    task_id = null,
    job_id = null,
    session_key = null,
    run_id = null,
    workspace_path = null,
    meta = null,
    dedupe_key = null,
    actor_user_id = null,
    category = null,
    timestamp = new Date(),
  } = opts;

  if (!VALID_EVENT_TYPES.has(event_type)) {
    throw new Error(`recordActivityLogEvent: invalid event_type "${event_type}"`);
  }
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`recordActivityLogEvent: invalid severity "${severity}"`);
  }
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`recordActivityLogEvent: invalid source "${source}"`);
  }
  if (!title || title.trim().length === 0) {
    throw new Error('recordActivityLogEvent: title is required');
  }

  const result = await pool.query(
    `INSERT INTO activity_logs (
       title, description, category, agent_id, task_id, timestamp,
       event_type, severity, source, actor_user_id,
       job_id, session_key, run_id, workspace_path, meta, dedupe_key
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      title.slice(0, 500),
      description,
      category,
      agent_id,
      task_id,
      timestamp,
      event_type,
      severity,
      source,
      actor_user_id,
      job_id,
      session_key,
      run_id,
      workspace_path,
      meta ? JSON.stringify(meta) : null,
      dedupe_key,
    ],
  );

  return result.rows[0] || null;
}

/**
 * Fire-and-forget wrapper — logs errors but never throws.
 * Use this inside route handlers where you don't want activity logging to
 * block or fail the primary response.
 */
async function recordActivityLogEventSafe(opts) {
  try {
    return await recordActivityLogEvent(opts);
  } catch (err) {
    console.error('[activityLogService] Failed to record event:', err.message, opts);
    return null;
  }
}

module.exports = {
  recordActivityLogEvent,
  recordActivityLogEventSafe,
  VALID_EVENT_TYPES,
  VALID_SEVERITIES,
  VALID_SOURCES,
};
