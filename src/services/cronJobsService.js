const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { getFileContent, putFileContent } = require('./openclawWorkspaceClient');

const CRON_JOBS_PATH = '/cron/jobs.json';

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
 * Transform dashboard payload to official OpenClaw cron.add format.
 *
 * Official shape (from docs.openclaw.ai/cron-jobs):
 *   Main session:
 *     { name, schedule, sessionTarget: "main", wakeMode, payload: { kind: "systemEvent", text } }
 *   Isolated session:
 *     { name, schedule, sessionTarget: "isolated", wakeMode, payload: { kind: "agentTurn", message }, delivery }
 *
 * Dashboard sends:
 *     { name, schedule, sessionTarget, payload: { message, model }, delivery, agentId, enabled, description }
 */
function toOfficialFormat(dashboardPayload) {
  const official = {};

  official.name = dashboardPayload.name;
  if (dashboardPayload.description) {
    official.description = dashboardPayload.description;
  }

  // Schedule — pass through (already uses { kind, expr/everyMs/at })
  if (dashboardPayload.schedule) {
    official.schedule = { ...dashboardPayload.schedule };
    // Ensure cron schedules always carry a timezone so the Gateway
    // interprets expressions in the instance's local time.
    if (official.schedule.kind === 'cron' && !official.schedule.tz) {
      official.schedule.tz = process.env.TIMEZONE || 'UTC';
    }
  }

  // Session target
  const sessionTarget = dashboardPayload.sessionTarget || 'main';
  official.sessionTarget = sessionTarget;

  // Wake mode — default to "now" (matches OpenClaw default)
  official.wakeMode = dashboardPayload.wakeMode || 'now';

  // Payload — transform based on session target
  const srcPayload = dashboardPayload.payload || {};
  const promptText = srcPayload.message || srcPayload.text || srcPayload.prompt || '';

  if (sessionTarget === 'main') {
    official.payload = {
      kind: 'systemEvent',
      text: promptText,
    };
  } else {
    official.payload = {
      kind: 'agentTurn',
      message: promptText,
    };
  }

  // Model override (only meaningful for isolated/agentTurn, but allowed on main too)
  if (srcPayload.model) {
    official.payload.model = srcPayload.model;
  }

  // Agent binding
  if (dashboardPayload.agentId) {
    official.agentId = dashboardPayload.agentId;
  }

  // Enabled state
  if (dashboardPayload.enabled !== undefined) {
    official.enabled = dashboardPayload.enabled;
  }

  // Delivery config (only for isolated sessions per docs, but pass through)
  if (dashboardPayload.delivery && dashboardPayload.delivery.mode) {
    official.delivery = { ...dashboardPayload.delivery };
  }

  return official;
}

/**
 * Transform official OpenClaw cron job back to dashboard-friendly format.
 * Ensures the dashboard can read payload.message regardless of payload.kind.
 */
function fromOfficialFormat(job) {
  if (!job) return job;

  const normalized = { ...job };

  // Ensure payload.message is set for dashboard display
  if (normalized.payload) {
    if (!normalized.payload.message && normalized.payload.text) {
      normalized.payload.message = normalized.payload.text;
    }
    if (!normalized.payload.message && normalized.payload.prompt) {
      normalized.payload.message = normalized.payload.prompt;
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
    try {
      parsed = JSON.parse(raw);
    } catch (parseError) {
      logger.warn('jobs.json contains invalid JSON — attempting auto-repair', {
        path: CRON_JOBS_PATH,
        error: parseError.message,
        preview: typeof raw === 'string' ? raw.substring(0, 200) : String(raw).substring(0, 200),
      });

      // Attempt to fix bare newlines inside JSON string values and retry
      try {
        const fixed = fixBareNewlinesInJsonStrings(typeof raw === 'string' ? raw : String(raw));
        parsed = JSON.parse(fixed);
        logger.info('jobs.json auto-repair succeeded — rewriting fixed content', { path: CRON_JOBS_PATH });
        // Rewrite the fixed content so future reads don't need to repair again
        putFileContent(CRON_JOBS_PATH, fixed).catch(writeErr => {
          logger.warn('jobs.json auto-repair: could not rewrite fixed file', { error: writeErr.message });
        });
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

    if (Array.isArray(parsed)) {
      const map = {};
      parsed.forEach(job => {
        const id = job.jobId || job.id || uuidv4();
        map[id] = { ...job, jobId: id };
      });
      return map;
    }
    
    if (parsed.jobs) {
      if (Array.isArray(parsed.jobs)) {
        const map = {};
        parsed.jobs.forEach(job => {
          const id = job.jobId || job.id || uuidv4();
          map[id] = { ...job, jobId: id };
        });
        return map;
      }
      return parsed.jobs;
    }
    
    return parsed;
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

/**
 * Validate cron job payload (dashboard format)
 * @param {Object} job - Job payload to validate
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
function validateCronJob(job) {
  const errors = [];
  
  if (!job.name || typeof job.name !== 'string' || job.name.trim().length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  
  if (job.name && job.name.length > 200) {
    errors.push('name must be 200 characters or less');
  }
  
  if (!job.schedule || typeof job.schedule !== 'object') {
    errors.push('schedule is required and must be an object');
  } else {
    const { kind } = job.schedule;
    if (!kind || !['cron', 'every', 'at'].includes(kind)) {
      errors.push('schedule.kind must be one of: cron, every, at');
    }
    
    if (kind === 'cron') {
      if (!job.schedule.expr || typeof job.schedule.expr !== 'string') {
        errors.push('schedule.expr is required for cron schedules');
      }
      if (job.schedule.expr) {
        const parts = job.schedule.expr.trim().split(/\s+/);
        if (parts.length < 5 || parts.length > 6) {
          errors.push('schedule.expr must be a valid cron expression (5 or 6 fields)');
        }
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
  
  if (job.sessionTarget && !['main', 'isolated'].includes(job.sessionTarget)) {
    errors.push('sessionTarget must be either "main" or "isolated"');
  }
  
  if (job.delivery) {
    if (typeof job.delivery !== 'object') {
      errors.push('delivery must be an object');
    } else if (job.delivery.mode && !['announce', 'none', 'webhook'].includes(job.delivery.mode)) {
      errors.push('delivery.mode must be one of: "announce", "none", "webhook"');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Create a new cron job via the Gateway cron.add tool.
 * Falls back to direct file write if the Gateway tool is unavailable.
 * @param {Object} payload - Dashboard-format job payload
 * @returns {Promise<Object>} Created job
 */
async function createCronJob(payload) {
  const validation = validateCronJob(payload);
  if (!validation.valid) {
    const err = new Error(`Invalid cron job: ${validation.errors.join(', ')}`);
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    err.errors = validation.errors;
    throw err;
  }

  const officialPayload = toOfficialFormat(payload);

  // Try Gateway cron.add first
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    const result = await invokeTool('cron.add', officialPayload);
    if (result) {
      const job = result.job || result;
      const jobId = job.jobId || job.id || uuidv4();
      logger.info('Cron job created via Gateway cron.add', { jobId, name: payload.name });
      return fromOfficialFormat({
        ...job,
        jobId,
        id: jobId,
        source: 'gateway',
      });
    }
  } catch (gatewayErr) {
    if (gatewayErr.code === 'SERVICE_NOT_CONFIGURED' || gatewayErr.code === 'SERVICE_UNAVAILABLE') {
      throw gatewayErr;
    }
    logger.warn('Gateway cron.add failed, falling back to file write', {
      error: gatewayErr.message,
    });
  }

  // Fallback: write directly to jobs.json
  const jobs = await readCronJobs();
  const jobId = payload.jobId || uuidv4();

  const existingNames = Object.values(jobs).map(j => j.name);
  if (existingNames.includes(payload.name)) {
    const err = new Error(`A cron job with name "${payload.name}" already exists`);
    err.status = 409;
    err.code = 'DUPLICATE_NAME';
    throw err;
  }

  const newJob = {
    ...officialPayload,
    jobId,
    id: jobId,
    source: 'gateway',
    enabled: payload.enabled !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Compute state.nextRunAtMs so the Gateway can arm the timer
  if (newJob.enabled !== false) {
    const nextMs = computeNextRunAtMs(newJob);
    if (nextMs) {
      newJob.state = { nextRunAtMs: nextMs };
    }
  }

  jobs[jobId] = newJob;
  await writeCronJobs(jobs);

  logger.info('Cron job created via file fallback', { jobId, name: newJob.name });
  return fromOfficialFormat(newJob);
}

/**
 * Update an existing cron job via Gateway cron.update.
 * Falls back to direct file write if the Gateway tool is unavailable.
 * @param {string} jobId - Job ID
 * @param {Object} payload - Dashboard-format update payload
 * @returns {Promise<Object>} Updated job
 */
async function updateCronJob(jobId, payload) {
  const officialPatch = toOfficialFormat(payload);

  // Try Gateway cron.update first
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    const result = await invokeTool('cron.update', {
      jobId,
      patch: officialPatch,
    });
    if (result) {
      const job = result.job || result;
      logger.info('Cron job updated via Gateway cron.update', { jobId, name: payload.name });
      return fromOfficialFormat({
        ...job,
        jobId,
        id: jobId,
        source: 'gateway',
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
    id: jobId,
    source: 'gateway',
    updatedAt: new Date().toISOString(),
  };

  const validation = validateCronJob({
    ...updatedJob,
    payload: { message: updatedJob.payload?.text || updatedJob.payload?.message },
  });
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
    updatedJob.state = {};
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
        id: jobId,
        source: 'gateway',
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

  // Fallback: update in jobs.json
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
  job.updatedAt = new Date().toISOString();

  if (enabled) {
    // Re-compute nextRunAtMs so the Gateway re-arms the timer
    const nextMs = computeNextRunAtMs(job);
    if (nextMs) {
      job.state = { ...(job.state || {}), nextRunAtMs: nextMs };
    }
  } else {
    // Clear nextRunAtMs when disabling
    job.state = {};
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
        id: jobId,
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

  // First, try a simple fix: replace bare (unescaped) newlines and carriage
  // returns that appear inside JSON string values.  We do this by scanning
  // character-by-character and escaping control chars that appear between
  // unescaped double-quote pairs.
  const fixed = fixBareNewlinesInJsonStrings(typeof raw === 'string' ? raw : String(raw));

  let parsed;
  try {
    parsed = JSON.parse(fixed);
  } catch (err) {
    logger.error('repairCronJobs: could not parse even after newline fix', { error: err.message });
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
  jobsArray.forEach(job => {
    const id = job.jobId || job.id || uuidv4();
    jobsMap[id] = { ...job, jobId: id };
  });

  await writeCronJobs(jobsMap);
  logger.info('repairCronJobs: jobs.json repaired and rewritten', { count: jobsArray.length });

  return { recovered: jobsArray.length, lost: 0, jobs: jobsMap };
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
