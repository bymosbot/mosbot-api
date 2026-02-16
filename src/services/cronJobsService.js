const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { getFileContent, putFileContent } = require('./openclawWorkspaceClient');

const CRON_JOBS_PATH = '/cron/jobs.json';

/**
 * Read and parse cron jobs from OpenClaw workspace
 * @returns {Promise<Object>} Map of jobId -> job object
 */
async function readCronJobs() {
  try {
    const content = await getFileContent(CRON_JOBS_PATH);
    if (!content) {
      // File doesn't exist yet, return empty map
      return {};
    }

    const parsed = JSON.parse(typeof content === 'string' ? content : content.content || content);
    
    // Handle various shapes: array, { jobs: array }, { jobs: map }, map
    if (Array.isArray(parsed)) {
      // Convert array to map
      const map = {};
      parsed.forEach(job => {
        const id = job.jobId || job.id || uuidv4();
        map[id] = { ...job, jobId: id };
      });
      return map;
    }
    
    if (parsed.jobs) {
      if (Array.isArray(parsed.jobs)) {
        // { jobs: [...] }
        const map = {};
        parsed.jobs.forEach(job => {
          const id = job.jobId || job.id || uuidv4();
          map[id] = { ...job, jobId: id };
        });
        return map;
      }
      // { jobs: { id: job, ... } }
      return parsed.jobs;
    }
    
    // Assume root is the map
    return parsed;
  } catch (error) {
    if (error.status === 404 || error.code === 'OPENCLAW_SERVICE_ERROR') {
      // File doesn't exist, return empty
      return {};
    }
    throw error;
  }
}

/**
 * Write cron jobs map back to OpenClaw workspace
 * @param {Object} jobsMap - Map of jobId -> job object
 */
async function writeCronJobs(jobsMap) {
  const payload = {
    jobs: jobsMap
  };
  await putFileContent(CRON_JOBS_PATH, JSON.stringify(payload, null, 2));
  
  // Best-effort: try to trigger scheduler reload
  try {
    const { invokeTool } = require('./openclawGatewayClient');
    await invokeTool('cron.reload', {});
    logger.info('Triggered cron.reload after jobs.json update');
  } catch (reloadErr) {
    // Ignore if tool doesn't exist or fails
    logger.warn('cron.reload not available or failed (this is OK)', { 
      error: reloadErr.message 
    });
  }
}

/**
 * Validate cron job payload
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
  
  // Validate schedule
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
      // Basic cron expression validation (5 or 6 fields)
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
  
  // Validate sessionTarget (optional)
  if (job.sessionTarget && !['main', 'isolated'].includes(job.sessionTarget)) {
    errors.push('sessionTarget must be either "main" or "isolated"');
  }
  
  // Validate delivery (optional)
  if (job.delivery) {
    if (typeof job.delivery !== 'object') {
      errors.push('delivery must be an object');
    } else if (job.delivery.mode && !['announce', 'none'].includes(job.delivery.mode)) {
      errors.push('delivery.mode must be either "announce" or "none"');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Create a new cron job
 * @param {Object} payload - Job payload
 * @returns {Promise<Object>} Created job with jobId
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
  
  const jobs = await readCronJobs();
  
  // Generate jobId if not provided
  const jobId = payload.jobId || uuidv4();
  
  // Check for duplicate name
  const existingNames = Object.values(jobs).map(j => j.name);
  if (existingNames.includes(payload.name)) {
    const err = new Error(`A cron job with name "${payload.name}" already exists`);
    err.status = 409;
    err.code = 'DUPLICATE_NAME';
    throw err;
  }
  
  const newJob = {
    ...payload,
    jobId,
    id: jobId,
    source: 'gateway',
    enabled: payload.enabled !== false, // Default to enabled
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  jobs[jobId] = newJob;
  await writeCronJobs(jobs);
  
  logger.info('Cron job created', { jobId, name: newJob.name });
  return newJob;
}

/**
 * Update an existing cron job
 * @param {string} jobId - Job ID
 * @param {Object} payload - Update payload (partial)
 * @returns {Promise<Object>} Updated job
 */
async function updateCronJob(jobId, payload) {
  const jobs = await readCronJobs();
  
  if (!jobs[jobId]) {
    const err = new Error(`Cron job not found: ${jobId}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  
  const existingJob = jobs[jobId];
  
  // Don't allow updating config jobs
  if (existingJob.source === 'config') {
    const err = new Error('Cannot update config-sourced cron jobs');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
  
  // Merge update with existing job
  const updatedJob = {
    ...existingJob,
    ...payload,
    jobId, // Preserve ID
    id: jobId,
    source: 'gateway', // Force gateway source
    updatedAt: new Date().toISOString()
  };
  
  // Validate merged job
  const validation = validateCronJob(updatedJob);
  if (!validation.valid) {
    const err = new Error(`Invalid cron job update: ${validation.errors.join(', ')}`);
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    err.errors = validation.errors;
    throw err;
  }
  
  // Check for duplicate name (excluding current job)
  const otherJobs = Object.entries(jobs).filter(([id]) => id !== jobId);
  const existingNames = otherJobs.map(([, j]) => j.name);
  if (existingNames.includes(updatedJob.name)) {
    const err = new Error(`A cron job with name "${updatedJob.name}" already exists`);
    err.status = 409;
    err.code = 'DUPLICATE_NAME';
    throw err;
  }
  
  jobs[jobId] = updatedJob;
  await writeCronJobs(jobs);
  
  logger.info('Cron job updated', { jobId, name: updatedJob.name });
  return updatedJob;
}

/**
 * Delete a cron job
 * @param {string} jobId - Job ID
 */
async function deleteCronJob(jobId) {
  const jobs = await readCronJobs();
  
  if (!jobs[jobId]) {
    const err = new Error(`Cron job not found: ${jobId}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  
  const job = jobs[jobId];
  
  // Don't allow deleting config jobs
  if (job.source === 'config') {
    const err = new Error('Cannot delete config-sourced cron jobs');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
  
  delete jobs[jobId];
  await writeCronJobs(jobs);
  
  logger.info('Cron job deleted', { jobId, name: job.name });
}

/**
 * Set enabled state for a cron job
 * @param {string} jobId - Job ID
 * @param {boolean} enabled - Enabled state
 * @returns {Promise<Object>} Updated job
 */
async function setCronJobEnabled(jobId, enabled) {
  const jobs = await readCronJobs();
  
  if (!jobs[jobId]) {
    const err = new Error(`Cron job not found: ${jobId}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  
  const job = jobs[jobId];
  
  // Don't allow updating config jobs
  if (job.source === 'config') {
    const err = new Error('Cannot update config-sourced cron jobs');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
  
  job.enabled = enabled;
  job.updatedAt = new Date().toISOString();
  
  jobs[jobId] = job;
  await writeCronJobs(jobs);
  
  logger.info('Cron job enabled state updated', { jobId, name: job.name, enabled });
  return job;
}

/**
 * Update heartbeat configuration in OpenClaw config
 * @param {string} agentId - Agent ID
 * @param {Object} heartbeatConfig - Heartbeat configuration
 * @returns {Promise<Object>} Updated heartbeat config
 */
async function updateHeartbeatConfig(agentId, heartbeatConfig) {
  try {
    // Read current OpenClaw config
    const configPath = '/openclaw.json';
    const configContent = await getFileContent(configPath);
    
    if (!configContent) {
      const err = new Error('OpenClaw config not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }
    
    const config = JSON.parse(typeof configContent === 'string' ? configContent : configContent.content || configContent);
    
    // Find the agent in config - handle both agents.list and agents array formats
    let agentsList = null;
    if (config.agents && Array.isArray(config.agents.list)) {
      // New format: { agents: { list: [...] } }
      agentsList = config.agents.list;
    } else if (config.agents && Array.isArray(config.agents)) {
      // Old format: { agents: [...] }
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
    
    // Update heartbeat config
    const agent = agentsList[agentIndex];
    if (!agent.heartbeat) {
      agent.heartbeat = {};
    }
    
    // Merge heartbeat config
    Object.assign(agent.heartbeat, heartbeatConfig);
    
    // Write back to OpenClaw config
    await putFileContent(configPath, JSON.stringify(config, null, 2));
    
    logger.info('Heartbeat config updated', { agentId, heartbeatConfig });
    
    // Best-effort: try to trigger config reload
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
  // Extract agent ID from job ID (format: heartbeat-{agentId})
  const agentId = jobId.replace('heartbeat-', '');
  
  if (!agentId) {
    const err = new Error('Invalid heartbeat job ID');
    err.status = 400;
    err.code = 'INVALID_JOB_ID';
    throw err;
  }
  
  // Build heartbeat config from payload
  const heartbeatConfig = {};
  
  // Handle schedule
  if (payload.schedule) {
    if (payload.schedule.kind === 'every' && payload.schedule.label) {
      heartbeatConfig.every = payload.schedule.label;
    } else if (payload.schedule.kind === 'cron' && payload.schedule.expr) {
      heartbeatConfig.cron = payload.schedule.expr;
    }
  }
  
  // Handle payload fields
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
  
  // Update the config
  const updatedConfig = await updateHeartbeatConfig(agentId, heartbeatConfig);
  
  // Return job-like structure for consistency
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

module.exports = {
  createCronJob,
  updateCronJob,
  deleteCronJob,
  setCronJobEnabled,
  updateHeartbeatJob,
  updateHeartbeatConfig,
  readCronJobs,
  writeCronJobs,
  validateCronJob
};
