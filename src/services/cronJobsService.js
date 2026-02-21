const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { getFileContent, putFileContent } = require('./openclawWorkspaceClient');
const { parseJsonWithLiteralNewlines } = require('./openclawGatewayClient');

const CRON_JOBS_PATH = '/cron/jobs.json';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(str) {
  return typeof str === 'string' && UUID_RE.test(str);
}

/**
 * Compute the next run timestamp (ms) for a cron job based on its schedule.
 * Returns null if the schedule cannot be parsed.
 */
function computeNextRunAtMs(job) {
  const sched = job.schedule || {};
  try {
    if (sched.kind === 'cron' && sched.expr) {
      const { CronExpressionParser } = require('cron-parser');
      const options = {};
      if (sched.tz) options.tz = sched.tz;
      const interval = CronExpressionParser.parse(sched.expr, options);
      return interval.next().getTime();
    }
    if (sched.kind === 'every' && sched.everyMs) {
      return Date.now() + sched.everyMs;
    }
    if (sched.kind === 'at' && sched.at) {
      return new Date(sched.at).getTime();
    }
  } catch (err) {
    logger.warn('Failed to compute nextRunAtMs', { jobId: job.jobId, error: err.message });
  }
  return null;
}

/**
 * Convert an interval (everyMs) to a cron expression for OpenClaw.
 * Cron has minute granularity; sub-minute intervals are rounded up to 1 minute.
 *
 * @param {number} everyMs - Interval in milliseconds
 * @returns {{ expr: string }} Cron expression (5 fields: minute hour dom month dow)
 */
function everyMsToCronExpr(everyMs) {
  const MS_PER_MIN = 60000;
  const MS_PER_HOUR = 3600000;

  if (!everyMs || everyMs < MS_PER_MIN) {
    return { expr: '* * * * *' };
  }

  const minutes = everyMs / MS_PER_MIN;
  const hours = everyMs / MS_PER_HOUR;

  if (hours >= 1 && Number.isInteger(hours) && hours <= 24) {
    return { expr: `0 */${hours} * * *` };
  }
  if (minutes >= 1 && minutes <= 60 && Number.isInteger(minutes)) {
    return { expr: `*/${minutes} * * * *` };
  }
  const minutesRounded = Math.max(1, Math.ceil(minutes));
  return { expr: `*/${minutesRounded} * * * *` };
}

/**
 * Transform client payload to official OpenClaw cron format.
 *
 * The client now sends the official schema directly — payload.kind is explicit
 * (agentTurn or systemEvent) rather than being derived from sessionTarget.
 * This function normalises legacy shapes and fills in defaults.
 *
 * Interval schedules (kind: 'every') are translated to cron so OpenClaw
 * receives only cron-compatible schedules.
 *
 * PATCH semantics: only fields explicitly present in clientPayload are included
 * in the output. Fields absent from clientPayload are omitted so they don't
 * accidentally overwrite stored values during partial updates.
 */
function toOfficialFormat(clientPayload) {
  const official = {};

  if (clientPayload.name !== undefined) {
    official.name = clientPayload.name;
  }
  if (clientPayload.description !== undefined) {
    official.description = clientPayload.description;
  }

  // Schedule — pass through; translate 'every' to cron for OpenClaw
  if (clientPayload.schedule) {
    const sched = clientPayload.schedule;
    if (sched.kind === 'every' && typeof sched.everyMs === 'number' && sched.everyMs > 0) {
      const { expr } = everyMsToCronExpr(sched.everyMs);
      const tz = sched.tz || process.env.TIMEZONE || 'UTC';
      official.schedule = { kind: 'cron', expr, tz };
    } else {
      official.schedule = { ...sched };
      if (official.schedule.kind === 'cron' && !official.schedule.tz) {
        official.schedule.tz = process.env.TIMEZONE || 'UTC';
      }
    }
  }

  // Session target — only include when explicitly provided.
  // For agentTurn jobs, 'isolated' is the only valid value; enforce it here
  // so legacy jobs created without sessionTarget get corrected on next write.
  if (clientPayload.sessionTarget !== undefined) {
    official.sessionTarget = clientPayload.sessionTarget;
  }

  // Wake mode — only include when explicitly provided
  if (clientPayload.wakeMode !== undefined) {
    official.wakeMode = clientPayload.wakeMode;
  }

  // Payload — use explicit kind from client; fall back to legacy derivation
  if (clientPayload.payload !== undefined) {
    const srcPayload = clientPayload.payload || {};
    // Determine sessionTarget for kind inference: prefer explicit value, then
    // fall back to the payload kind hint.
    const sessionTarget = clientPayload.sessionTarget;
    const payloadKind = srcPayload.kind || (sessionTarget === 'isolated' ? 'agentTurn' : 'systemEvent');

    if (payloadKind === 'agentTurn') {
      official.payload = {
        kind: 'agentTurn',
        message: srcPayload.message || srcPayload.text || srcPayload.prompt || '',
      };
      if (srcPayload.model) {
        official.payload.model = srcPayload.model;
      }
      // agentTurn always requires isolated — enforce it unconditionally
      official.sessionTarget = 'isolated';
    } else {
      official.payload = {
        kind: 'systemEvent',
        text: srcPayload.text || srcPayload.message || srcPayload.prompt || '',
      };
    }
  }

  // Agent binding
  if (clientPayload.agentId !== undefined) {
    official.agentId = clientPayload.agentId;
  }

  // Enabled state
  if (clientPayload.enabled !== undefined) {
    official.enabled = clientPayload.enabled;
  }

  // Delivery config
  if (clientPayload.delivery && clientPayload.delivery.mode) {
    official.delivery = { ...clientPayload.delivery };
  }

  return official;
}

/**
 * Normalise an OpenClaw cron job to the official schema before returning to clients.
 * - Converts legacy ISO string timestamps to millisecond epoch integers.
 * - Ensures payload.message is always populated for agentTurn jobs.
 * - Ensures payload.text is always populated for systemEvent jobs.
 */
function fromOfficialFormat(job) {
  if (!job) return job;

  const normalized = { ...job };

  // Normalise timestamps to milliseconds
  if (normalized.createdAt && !normalized.createdAtMs) {
    normalized.createdAtMs = new Date(normalized.createdAt).getTime();
  }
  if (normalized.updatedAt && !normalized.updatedAtMs) {
    normalized.updatedAtMs = new Date(normalized.updatedAt).getTime();
  }

  // Normalise state timestamps
  if (normalized.state) {
    normalized.state = { ...normalized.state };
    if (normalized.state.lastRunAt && !normalized.state.lastRunAtMs) {
      normalized.state.lastRunAtMs = new Date(normalized.state.lastRunAt).getTime();
    }
    if (normalized.state.nextRunAt && !normalized.state.nextRunAtMs) {
      normalized.state.nextRunAtMs = new Date(normalized.state.nextRunAt).getTime();
    }
  }

  // Ensure payload fields are consistent for both payload kinds
  if (normalized.payload) {
    if (normalized.payload.kind === 'agentTurn') {
      if (!normalized.payload.message && normalized.payload.text) {
        normalized.payload.message = normalized.payload.text;
      }
      if (!normalized.payload.message && normalized.payload.prompt) {
        normalized.payload.message = normalized.payload.prompt;
      }
    } else if (normalized.payload.kind === 'systemEvent') {
      if (!normalized.payload.text && normalized.payload.message) {
        normalized.payload.text = normalized.payload.message;
      }
    } else {
      // Legacy: no kind set — populate both fields
      if (!normalized.payload.message && normalized.payload.text) {
        normalized.payload.message = normalized.payload.text;
      }
      if (!normalized.payload.message && normalized.payload.prompt) {
        normalized.payload.message = normalized.payload.prompt;
      }
    }
  }

  return normalized;
}

/**
 * Read and parse cron jobs from OpenClaw workspace
 * @returns {Promise<Object>} Map of jobId -> job object
 */
async function readCronJobs() {
  try {
    const content = await getFileContent(CRON_JOBS_PATH);
    if (!content) {
      return {};
    }

    const raw = typeof content === 'string' ? content : content.content || content;
    let parsed;
    let wasRepaired = false;
    try {
      parsed = JSON.parse(raw);
    } catch (parseError) {
      logger.warn('jobs.json contains invalid JSON — attempting auto-repair', {
        path: CRON_JOBS_PATH,
        error: parseError.message,
        preview: typeof raw === 'string' ? raw.substring(0, 200) : String(raw).substring(0, 200),
      });

      // Use the same lenient parser that cronList uses — handles markdown code
      // blocks with unescaped quotes and bare newlines inside JSON strings.
      try {
        parsed = parseJsonWithLiteralNewlines(typeof raw === 'string' ? raw : String(raw));
        wasRepaired = true;
      } catch (repairError) {
        logger.error('jobs.json auto-repair failed', {
          path: CRON_JOBS_PATH,
          originalError: parseError.message,
          repairError: repairError.message,
        });
        const err = new Error(`jobs.json is corrupted and cannot be parsed: ${parseError.message}`);
        err.status = 500;
        err.code = 'JOBS_FILE_CORRUPTED';
        throw err;
      }
    }

    let jobsMap;
    if (Array.isArray(parsed)) {
      jobsMap = {};
      parsed.forEach(job => {
        const jobId = job.jobId || job.id;
        if (jobId) jobsMap[jobId] = { ...job, jobId };
      });
    } else if (parsed.jobs) {
      if (Array.isArray(parsed.jobs)) {
        jobsMap = {};
        parsed.jobs.forEach(job => {
          const jobId = job.jobId || job.id;
          if (jobId) jobsMap[jobId] = { ...job, jobId };
        });
      } else {
        jobsMap = parsed.jobs;
      }
    } else {
      jobsMap = parsed;
    }

    // Migration: ensure every job has both jobId (slug) and id (UUID).
    // Also fix agentTurn jobs that were stored with sessionTarget='main'.
    let migrationNeeded = false;
    for (const [mapKey, job] of Object.entries(jobsMap)) {
      // Backfill jobId from the map key if missing
      if (!job.jobId) {
        job.jobId = mapKey;
        migrationNeeded = true;
      }
      // Backfill id (UUID) if missing — OpenClaw requires it for cron.runs lookups
      if (!job.id) {
        job.id = isUuid(job.jobId) ? job.jobId : uuidv4();
        migrationNeeded = true;
      }
      if (job.payload?.kind === 'agentTurn' && job.sessionTarget !== 'isolated') {
        logger.info('jobs.json migration: correcting sessionTarget to "isolated" for agentTurn job', {
          jobId: job.jobId,
          name: job.name,
          was: job.sessionTarget,
        });
        job.sessionTarget = 'isolated';
        migrationNeeded = true;
      }
    }

    // If we repaired the file or migrated any jobs, rewrite with clean JSON.
    if (wasRepaired || migrationNeeded) {
      logger.info('jobs.json rewrite triggered', {
        path: CRON_JOBS_PATH,
        count: Object.keys(jobsMap).length,
        reason: wasRepaired ? 'auto-repair' : 'id/sessionTarget migration',
      });
      writeCronJobs(jobsMap).catch(writeErr => {
        logger.warn('jobs.json rewrite failed', { error: writeErr.message });
      });
    }

    return jobsMap;
  } catch (error) {
    if (error.status === 404 || error.code === 'OPENCLAW_SERVICE_ERROR') {
      return {};
    }
    throw error;
  }
}

/**
 * Write cron jobs map back to OpenClaw workspace.
 * 
 * The OpenClaw Gateway expects { version: 1, jobs: [...] } (array format).
 * Internally we use a map (jobId -> job) for easy lookups, so we convert
 * back to an array before writing.
 *
 * @param {Object} jobsMap - Map of jobId -> job object
 */
async function writeCronJobs(jobsMap) {
  const jobsArray = Object.values(jobsMap);
  const payload = {
    version: 1,
    jobs: jobsArray,
  };
  await putFileContent(CRON_JOBS_PATH, JSON.stringify(payload, null, 2));
  
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    await invokeTool('cron.reload', {});
    logger.info('Triggered cron.reload after jobs.json update');
  } catch (reloadErr) {
    logger.warn('cron.reload not available or failed (this is OK)', { 
      error: reloadErr.message 
    });
  }
}

const VALID_AGENT_IDS = ['coo', 'cto', 'cpo', 'cmo'];
const VALID_SESSION_TARGETS = ['main', 'isolated'];
const VALID_WAKE_MODES = ['now', 'next-heartbeat'];
const VALID_SCHEDULE_KINDS = ['cron', 'every', 'at'];
const VALID_PAYLOAD_KINDS = ['agentTurn', 'systemEvent'];
const VALID_DELIVERY_MODES = ['none', 'announce'];

/**
 * Validate a cron job payload against the official schema.
 * @param {Object} job - Job payload to validate
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
function validateCronJob(job) {
  const errors = [];

  // name
  if (!job.name || typeof job.name !== 'string' || job.name.trim().length === 0) {
    errors.push('name is required and must be a non-empty string');
  } else if (job.name.length > 200) {
    errors.push('name must be 200 characters or less');
  }

  // agentId
  if (!job.agentId) {
    errors.push('agentId is required');
  } else if (!VALID_AGENT_IDS.includes(job.agentId)) {
    errors.push(`agentId must be one of: ${VALID_AGENT_IDS.join(', ')}`);
  }

  // enabled
  if (job.enabled !== undefined && typeof job.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  // schedule
  if (!job.schedule || typeof job.schedule !== 'object') {
    errors.push('schedule is required and must be an object');
  } else {
    const { kind } = job.schedule;
    if (!kind || !VALID_SCHEDULE_KINDS.includes(kind)) {
      errors.push(`schedule.kind must be one of: ${VALID_SCHEDULE_KINDS.join(', ')}`);
    }

    if (kind === 'cron') {
      if (!job.schedule.expr || typeof job.schedule.expr !== 'string') {
        errors.push('schedule.expr is required for cron schedules');
      } else {
        const parts = job.schedule.expr.trim().split(/\s+/);
        if (parts.length < 5 || parts.length > 6) {
          errors.push('schedule.expr must be a valid cron expression (5 or 6 fields)');
        }
      }
      if (!job.schedule.tz) {
        errors.push('schedule.tz is required for cron schedules');
      }
    }

    if (kind === 'every') {
      if (!job.schedule.everyMs || typeof job.schedule.everyMs !== 'number' || job.schedule.everyMs <= 0) {
        errors.push('schedule.everyMs is required and must be a positive number for every schedules');
      }
    }

    if (kind === 'at') {
      if (!job.schedule.at) {
        errors.push('schedule.at is required for at schedules');
      }
    }
  }

  // sessionTarget
  if (!job.sessionTarget) {
    errors.push('sessionTarget is required');
  } else if (!VALID_SESSION_TARGETS.includes(job.sessionTarget)) {
    errors.push(`sessionTarget must be one of: ${VALID_SESSION_TARGETS.join(', ')}`);
  }

  // wakeMode
  if (!job.wakeMode) {
    errors.push('wakeMode is required');
  } else if (!VALID_WAKE_MODES.includes(job.wakeMode)) {
    errors.push(`wakeMode must be one of: ${VALID_WAKE_MODES.join(', ')}`);
  }

  // payload
  if (!job.payload || typeof job.payload !== 'object') {
    errors.push('payload is required and must be an object');
  } else {
    const { kind: payloadKind } = job.payload;
    if (!payloadKind || !VALID_PAYLOAD_KINDS.includes(payloadKind)) {
      errors.push(`payload.kind must be one of: ${VALID_PAYLOAD_KINDS.join(', ')}`);
    }

    if (payloadKind === 'agentTurn') {
      if (!job.payload.message || typeof job.payload.message !== 'string') {
        errors.push('payload.message is required when payload.kind is agentTurn');
      }
      if (!job.payload.model || typeof job.payload.model !== 'string') {
        errors.push('payload.model is required when payload.kind is agentTurn');
      }
      // Cross-field: agentTurn requires isolated session
      if (job.sessionTarget && job.sessionTarget !== 'isolated') {
        errors.push('sessionTarget must be "isolated" when payload.kind is agentTurn');
      }
    }

    if (payloadKind === 'systemEvent') {
      if (!job.payload.text || typeof job.payload.text !== 'string') {
        errors.push('payload.text is required when payload.kind is systemEvent');
      }
    }
  }

  // delivery
  if (job.delivery !== undefined) {
    if (typeof job.delivery !== 'object') {
      errors.push('delivery must be an object');
    } else if (job.delivery.mode && !VALID_DELIVERY_MODES.includes(job.delivery.mode)) {
      errors.push(`delivery.mode must be one of: ${VALID_DELIVERY_MODES.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Create a new cron job via the Gateway cron.add tool.
 * Falls back to direct file write if the Gateway tool is unavailable.
 * @param {Object} payload - Dashboard-format job payload
 * @returns {Promise<Object>} Created job
 */
async function createCronJob(payload) {
  // Enforce isolated session for agentTurn jobs before validation so callers
  // that omit sessionTarget get the correct default rather than a validation error.
  const normalizedPayload = { ...payload };
  if (normalizedPayload.payload?.kind === 'agentTurn' && !normalizedPayload.sessionTarget) {
    normalizedPayload.sessionTarget = 'isolated';
  }

  const validation = validateCronJob(normalizedPayload);
  if (!validation.valid) {
    const err = new Error(`Invalid cron job: ${validation.errors.join(', ')}`);
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    err.errors = validation.errors;
    throw err;
  }

  const officialPayload = toOfficialFormat(normalizedPayload);

  // Attempt 1: Gateway cron.add via /tools/invoke
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    const result = await invokeTool('cron.add', officialPayload);
    if (result) {
      const job = result.job || result;
      // Preserve both id (UUID) and jobId (slug) assigned by the Gateway.
      // OpenClaw uses id internally for cron.runs history lookups.
      const jobId = job.jobId || job.id;
      const id = job.id || job.jobId;
      const nowMs = Date.now();
      logger.info('Cron job created via Gateway cron.add (tools/invoke)', { jobId, id, name: payload.name });
      return fromOfficialFormat({
        ...job,
        id,
        jobId,
        source: 'gateway',
        createdAtMs: job.createdAtMs || nowMs,
        updatedAtMs: job.updatedAtMs || nowMs,
      });
    }
    // null means tool not available — fall through to WS RPC
  } catch (gatewayErr) {
    if (gatewayErr.code === 'SERVICE_NOT_CONFIGURED' || gatewayErr.code === 'SERVICE_UNAVAILABLE') {
      throw gatewayErr;
    }
    logger.warn('Gateway cron.add (tools/invoke) failed, trying WS RPC', {
      error: gatewayErr.message,
    });
  }

  // Attempt 2: Gateway cron.add via WebSocket RPC
  try {
    const { gatewayWsRpc } = require('./openclawGatewayClient');
    const result = await gatewayWsRpc('cron.add', officialPayload);
    if (result) {
      const job = result.job || result;
      const jobId = job.jobId || job.id;
      const id = job.id || job.jobId;
      const nowMs = Date.now();
      logger.info('Cron job created via Gateway cron.add (WS RPC)', { jobId, id, name: payload.name });
      return fromOfficialFormat({
        ...job,
        id,
        jobId,
        source: 'gateway',
        createdAtMs: job.createdAtMs || nowMs,
        updatedAtMs: job.updatedAtMs || nowMs,
      });
    }
  } catch (wsErr) {
    if (wsErr.code === 'SERVICE_NOT_CONFIGURED' || wsErr.code === 'SERVICE_UNAVAILABLE') {
      throw wsErr;
    }
    logger.warn('Gateway cron.add (WS RPC) failed, falling back to file write', {
      error: wsErr.message,
    });
  }

  // Attempt 3: Write directly to jobs.json and trigger cron.reload.
  // OpenClaw assigns jobId and id when it loads the file on reload.
  // We write without jobId/id so OpenClaw generates them, then re-read
  // the file after reload to return the assigned identifiers.
  const existingJobs = await readCronJobs();

  const existingNames = Object.values(existingJobs).map(j => j.name);
  if (existingNames.includes(normalizedPayload.name)) {
    const err = new Error(`A cron job with name "${normalizedPayload.name}" already exists`);
    err.status = 409;
    err.code = 'DUPLICATE_NAME';
    throw err;
  }

  const nowMs = Date.now();
  // Use a temporary placeholder key so we can locate the job after reload.
  // OpenClaw will replace this with its own jobId when it processes the file.
  const tempKey = `__pending__${Date.now()}`;
  const newJob = {
    ...officialPayload,
    source: 'gateway',
    enabled: payload.enabled !== false,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastDurationMs: 0,
      consecutiveErrors: 0,
    },
  };

  if (newJob.enabled !== false) {
    const nextMs = computeNextRunAtMs(newJob);
    if (nextMs) newJob.state.nextRunAtMs = nextMs;
  }

  existingJobs[tempKey] = newJob;
  await writeCronJobs(existingJobs);

  // Re-read to pick up the jobId/id OpenClaw assigned after cron.reload.
  // Give the Gateway a moment to process the file.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const reloadedJobs = await readCronJobs();

  // Find the newly created job by name (most reliable match after reload).
  const created = Object.values(reloadedJobs).find(j => j.name === normalizedPayload.name);
  if (created) {
    logger.info('Cron job created via file fallback', {
      jobId: created.jobId,
      id: created.id,
      name: created.name,
      sessionTarget: created.sessionTarget,
    });
    return fromOfficialFormat(created);
  }

  // If OpenClaw hasn't processed the file yet, return what we wrote
  // with the temp key stripped — the job exists but IDs aren't assigned yet.
  logger.warn('Cron job written but OpenClaw has not yet assigned jobId; returning pending job', {
    name: normalizedPayload.name,
  });
  const { [tempKey]: pendingJob, ...rest } = existingJobs;
  void rest;
  return fromOfficialFormat({ ...pendingJob, jobId: null, id: null });
}

/**
 * Update an existing cron job via Gateway cron.update (PATCH semantics).
 * Falls back to direct file write if the Gateway tool is unavailable.
 * jobId and createdAtMs are immutable and cannot be changed by callers.
 * @param {string} jobId - Job ID
 * @param {Object} patch - Partial job fields to update (official schema)
 * @returns {Promise<Object>} Updated job
 */
async function updateCronJob(jobId, patch) {
  // Strip immutable fields from the incoming patch
  // eslint-disable-next-line no-unused-vars
  const { jobId: _jobId, createdAtMs: _createdAtMs, state: _state, ...safePatch } = patch;

  const officialPatch = toOfficialFormat(safePatch);

  // Try Gateway cron.update first
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    const result = await invokeTool('cron.update', {
      jobId,
      patch: officialPatch,
    });
    if (result) {
      const job = result.job || result;
      logger.info('Cron job updated via Gateway cron.update', { jobId, name: patch.name });
      return fromOfficialFormat({
        ...job,
        jobId,
        source: 'gateway',
        updatedAtMs: Date.now(),
      });
    }
  } catch (gatewayErr) {
    if (gatewayErr.code === 'SERVICE_NOT_CONFIGURED' || gatewayErr.code === 'SERVICE_UNAVAILABLE') {
      throw gatewayErr;
    }
    logger.warn('Gateway cron.update failed, falling back to file write', {
      error: gatewayErr.message,
    });
  }

  // Fallback: update in jobs.json directly
  let jobs;
  try {
    jobs = await readCronJobs();
  } catch (readErr) {
    if (readErr.code === 'JOBS_FILE_CORRUPTED') {
      logger.warn('jobs.json is corrupted; cannot safely update without losing existing jobs', {
        jobId,
        error: readErr.message,
      });
      throw readErr;
    }
    throw readErr;
  }

  if (!jobs[jobId]) {
    const err = new Error(`Cron job not found: ${jobId}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const existingJob = jobs[jobId];

  if (existingJob.source === 'config') {
    const err = new Error('Cannot update config-sourced cron jobs');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }

  const updatedJob = {
    ...existingJob,
    ...officialPatch,
    jobId,
    source: 'gateway',
    createdAtMs: existingJob.createdAtMs,
    updatedAtMs: Date.now(),
  };

  const validation = validateCronJob(updatedJob);
  if (!validation.valid) {
    const err = new Error(`Invalid cron job update: ${validation.errors.join(', ')}`);
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    err.errors = validation.errors;
    throw err;
  }

  const otherJobs = Object.entries(jobs).filter(([id]) => id !== jobId);
  const existingNames = otherJobs.map(([, j]) => j.name);
  if (existingNames.includes(updatedJob.name)) {
    const err = new Error(`A cron job with name "${updatedJob.name}" already exists`);
    err.status = 409;
    err.code = 'DUPLICATE_NAME';
    throw err;
  }

  // Recompute state.nextRunAtMs when schedule or enabled changes
  if (updatedJob.enabled !== false) {
    const nextMs = computeNextRunAtMs(updatedJob);
    if (nextMs) {
      updatedJob.state = { ...(updatedJob.state || {}), nextRunAtMs: nextMs };
    }
  } else {
    updatedJob.state = { ...(updatedJob.state || {}), nextRunAtMs: null };
  }

  jobs[jobId] = updatedJob;
  await writeCronJobs(jobs);

  logger.info('Cron job updated via file fallback', { jobId, name: updatedJob.name });
  return fromOfficialFormat(updatedJob);
}

/**
 * Delete a cron job via Gateway cron.remove.
 * Falls back to direct file write if the Gateway tool is unavailable.
 * @param {string} jobId - Job ID
 */
async function deleteCronJob(jobId) {
  // Try Gateway cron.remove first
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    const result = await invokeTool('cron.remove', { jobId });
    if (result !== null) {
      logger.info('Cron job deleted via Gateway cron.remove', { jobId });
      return;
    }
  } catch (gatewayErr) {
    if (gatewayErr.code === 'SERVICE_NOT_CONFIGURED' || gatewayErr.code === 'SERVICE_UNAVAILABLE') {
      throw gatewayErr;
    }
    logger.warn('Gateway cron.remove failed, falling back to file write', {
      error: gatewayErr.message,
    });
  }

  // Fallback: delete from jobs.json
  const jobs = await readCronJobs();

  if (!jobs[jobId]) {
    const err = new Error(`Cron job not found: ${jobId}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const job = jobs[jobId];

  if (job.source === 'config') {
    const err = new Error('Cannot delete config-sourced cron jobs');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }

  delete jobs[jobId];
  await writeCronJobs(jobs);

  logger.info('Cron job deleted via file fallback', { jobId, name: job.name });
}

/**
 * Set enabled state for a cron job via Gateway cron.update.
 * Falls back to direct file write if the Gateway tool is unavailable.
 * @param {string} jobId - Job ID
 * @param {boolean} enabled - Enabled state
 * @returns {Promise<Object>} Updated job
 */
async function setCronJobEnabled(jobId, enabled) {
  // Try Gateway cron.update first
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    const result = await invokeTool('cron.update', {
      jobId,
      patch: { enabled },
    });
    if (result) {
      const job = result.job || result;
      logger.info('Cron job enabled state updated via Gateway', { jobId, enabled });
      return fromOfficialFormat({
        ...job,
        jobId,
        source: 'gateway',
        updatedAtMs: Date.now(),
      });
    }
  } catch (gatewayErr) {
    if (gatewayErr.code === 'SERVICE_NOT_CONFIGURED' || gatewayErr.code === 'SERVICE_UNAVAILABLE') {
      throw gatewayErr;
    }
    logger.warn('Gateway cron.update (enabled) failed, falling back to file write', {
      error: gatewayErr.message,
    });
  }

  // Fallback: update enabled state in jobs.json
  const jobs = await readCronJobs();

  if (!jobs[jobId]) {
    const err = new Error(`Cron job not found: ${jobId}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const job = jobs[jobId];

  if (job.source === 'config') {
    const err = new Error('Cannot update config-sourced cron jobs');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }

  job.enabled = enabled;
  job.updatedAtMs = Date.now();

  if (enabled) {
    // Re-compute nextRunAtMs so the Gateway re-arms the timer
    const nextMs = computeNextRunAtMs(job);
    if (nextMs) {
      job.state = { ...(job.state || {}), nextRunAtMs: nextMs };
    }
  } else {
    // Clear nextRunAtMs when disabling
    job.state = { ...(job.state || {}), nextRunAtMs: null };
  }

  jobs[jobId] = job;
  await writeCronJobs(jobs);

  logger.info('Cron job enabled state updated via file fallback', { jobId, name: job.name, enabled });
  return fromOfficialFormat(job);
}

/**
 * Manually trigger a cron job to run immediately.
 *
 * Sets state.nextRunAtMs to a few seconds from now so the Gateway fires
 * the job on its next timer tick (~60 s polling interval).
 *
 * @param {string} jobId - Job ID
 * @returns {Promise<Object>} The triggered job in dashboard format
 */
async function triggerCronJob(jobId) {
  // Try Gateway cron.run first
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    const result = await invokeTool('cron.run', { jobId });
    if (result) {
      logger.info('Cron job triggered via Gateway', { jobId });
      const job = result.job || result;
      return fromOfficialFormat({
        ...job,
        jobId,
        source: 'gateway',
      });
    }
  } catch (gatewayErr) {
    if (gatewayErr.code === 'SERVICE_NOT_CONFIGURED' || gatewayErr.code === 'SERVICE_UNAVAILABLE') {
      throw gatewayErr;
    }
    logger.warn('Gateway cron.run failed, falling back to file trigger', {
      error: gatewayErr.message,
    });
  }

  // Fallback: set nextRunAtMs to near-immediate so the Gateway fires it
  const jobs = await readCronJobs();

  if (!jobs[jobId]) {
    const err = new Error(`Cron job not found: ${jobId}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const job = jobs[jobId];

  if (job.enabled === false) {
    const err = new Error('Cannot trigger a disabled cron job. Enable it first.');
    err.status = 400;
    err.code = 'JOB_DISABLED';
    throw err;
  }

  // Set nextRunAtMs to 3 seconds from now — the Gateway picks it up on
  // its next 60 s timer tick and fires the job.
  job.state = { ...(job.state || {}), nextRunAtMs: Date.now() + 3000 };
  jobs[jobId] = job;
  await writeCronJobs(jobs);

  logger.info('Cron job trigger requested via file fallback (nextRunAtMs set to now)', {
    jobId,
    name: job.name,
  });
  return fromOfficialFormat(job);
}

/**
 * Update heartbeat configuration in OpenClaw config
 * @param {string} agentId - Agent ID
 * @param {Object} heartbeatConfig - Heartbeat configuration
 * @returns {Promise<Object>} Updated heartbeat config
 */
async function updateHeartbeatConfig(agentId, heartbeatConfig) {
  try {
    const configPath = '/openclaw.json';
    const configContent = await getFileContent(configPath);
    
    if (!configContent) {
      const err = new Error('OpenClaw config not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }
    
    const config = JSON.parse(typeof configContent === 'string' ? configContent : configContent.content || configContent);
    
    let agentsList = null;
    if (config.agents && Array.isArray(config.agents.list)) {
      agentsList = config.agents.list;
    } else if (config.agents && Array.isArray(config.agents)) {
      agentsList = config.agents;
    } else {
      const err = new Error('Invalid OpenClaw config structure: agents.list or agents array not found');
      err.status = 500;
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    
    const agentIndex = agentsList.findIndex(a => a.id === agentId);
    if (agentIndex === -1) {
      const err = new Error(`Agent not found: ${agentId}`);
      err.status = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }
    
    const agent = agentsList[agentIndex];
    if (!agent.heartbeat) {
      agent.heartbeat = {};
    }
    
    Object.assign(agent.heartbeat, heartbeatConfig);
    
    await putFileContent(configPath, JSON.stringify(config, null, 2));
    
    logger.info('Heartbeat config updated', { agentId, heartbeatConfig });
    
    try {
      const { invokeTool } = require('./openclawGatewayClient');
      await invokeTool('config.reload', {});
      logger.info('Triggered config.reload after heartbeat update');
    } catch (reloadErr) {
      logger.warn('config.reload not available or failed (this is OK)', { 
        error: reloadErr.message 
      });
    }
    
    return agent.heartbeat;
  } catch (error) {
    logger.error('Failed to update heartbeat config', { agentId, error: error.message });
    throw error;
  }
}

/**
 * Update heartbeat job (wrapper that updates OpenClaw config)
 * @param {string} jobId - Job ID (format: heartbeat-{agentId})
 * @param {Object} payload - Update payload
 * @returns {Promise<Object>} Updated job
 */
async function updateHeartbeatJob(jobId, payload) {
  const agentId = jobId.replace('heartbeat-', '');
  
  if (!agentId) {
    const err = new Error('Invalid heartbeat job ID');
    err.status = 400;
    err.code = 'INVALID_JOB_ID';
    throw err;
  }
  
  const heartbeatConfig = {};
  
  if (payload.schedule) {
    if (payload.schedule.kind === 'every' && payload.schedule.label) {
      heartbeatConfig.every = payload.schedule.label;
    } else if (payload.schedule.kind === 'cron' && payload.schedule.expr) {
      heartbeatConfig.cron = payload.schedule.expr;
    }
  }
  
  if (payload.payload) {
    if (payload.payload.model) {
      heartbeatConfig.model = payload.payload.model;
    }
    if (payload.payload.session || payload.sessionTarget) {
      heartbeatConfig.session = payload.payload.session || payload.sessionTarget;
    }
    if (payload.payload.target) {
      heartbeatConfig.target = payload.payload.target;
    }
    if (payload.payload.prompt || payload.payload.message) {
      heartbeatConfig.prompt = payload.payload.prompt || payload.payload.message;
    }
    if (payload.payload.ackMaxChars) {
      heartbeatConfig.ackMaxChars = parseInt(payload.payload.ackMaxChars, 10);
    }
  }
  
  const updatedConfig = await updateHeartbeatConfig(agentId, heartbeatConfig);
  
  return {
    jobId,
    id: jobId,
    name: `${agentId.toUpperCase()} Heartbeat`,
    agentId,
    source: 'config',
    payload: {
      kind: 'heartbeat',
      ...updatedConfig
    },
    schedule: {
      kind: 'every',
      label: updatedConfig.every
    },
    updatedAt: new Date().toISOString()
  };
}

/**
 * Attempt to repair a corrupted jobs.json by reading the raw content and
 * extracting valid job objects using a lenient regex-based approach.
 *
 * This is a best-effort recovery: jobs with unescaped newlines in string
 * fields (e.g. payload.message) will have those newlines re-escaped so the
 * file becomes valid JSON again.
 *
 * @returns {Promise<{ recovered: number, lost: number, jobs: Object }>}
 */
async function repairCronJobs() {
  const raw = await getFileContent(CRON_JOBS_PATH);
  if (!raw) {
    return { recovered: 0, lost: 0, jobs: {} };
  }

  let parsed;
  try {
    parsed = parseJsonWithLiteralNewlines(typeof raw === 'string' ? raw : String(raw));
  } catch (err) {
    logger.error('repairCronJobs: could not parse even after lenient repair', { error: err.message });
    const e = new Error(`Could not repair jobs.json: ${err.message}`);
    e.status = 500;
    e.code = 'REPAIR_FAILED';
    throw e;
  }

  // Normalise to a map
  let jobsArray = [];
  if (Array.isArray(parsed)) {
    jobsArray = parsed;
  } else if (parsed.jobs && Array.isArray(parsed.jobs)) {
    jobsArray = parsed.jobs;
  } else if (typeof parsed === 'object') {
    jobsArray = Object.values(parsed);
  }

  const jobsMap = {};
  let lost = 0;
  jobsArray.forEach(job => {
    const jobId = job.jobId || job.id;
    if (!jobId) {
      logger.warn('repairCronJobs: skipping job with no jobId or id', { name: job.name });
      lost++;
      return;
    }
    jobsMap[jobId] = { ...job, jobId };
  });

  await writeCronJobs(jobsMap);
  logger.info('repairCronJobs: jobs.json repaired and rewritten', { count: Object.keys(jobsMap).length, lost });

  return { recovered: Object.keys(jobsMap).length, lost, jobs: jobsMap };
}

/**
 * Scan a JSON string and escape any bare (unescaped) newline / carriage-return
 * characters that appear inside string literals.  This repairs files written
 * with literal newlines in string values.
 *
 * @param {string} src - Raw file content
 * @returns {string} Repaired content
 */
function fixBareNewlinesInJsonStrings(src) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
    }

    result += ch;
  }

  return result;
}

module.exports = {
  createCronJob,
  updateCronJob,
  deleteCronJob,
  setCronJobEnabled,
  triggerCronJob,
  updateHeartbeatJob,
  updateHeartbeatConfig,
  readCronJobs,
  writeCronJobs,
  validateCronJob,
  toOfficialFormat,
  fromOfficialFormat,
  repairCronJobs,
  fixBareNewlinesInJsonStrings,
};
