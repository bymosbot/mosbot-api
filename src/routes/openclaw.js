const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const path = require('path');
const { requireAdmin } = require('./auth');
const { makeOpenClawRequest } = require('../services/openclawWorkspaceClient');

// Auth middleware - require valid JWT
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: { message: 'Authorization required', status: 401 } 
    });
  }
  
  const token = authHeader.substring(7);
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  
  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch (_err) {
    return res.status(401).json({ 
      error: { message: 'Invalid or expired token', status: 401 } 
    });
  }
};

function normalizeAndValidateWorkspacePath(inputPath) {
  const raw = typeof inputPath === 'string' && inputPath.trim() ? inputPath.trim() : '/';
  const asPosix = raw.replace(/\\/g, '/');

  // Force absolute-within-workspace paths ("/" is workspace root)
  const prefixed = asPosix.startsWith('/') ? asPosix : `/${asPosix}`;
  const normalized = path.posix.normalize(prefixed);

  // Reject traversal attempts (fail closed)
  if (normalized === '/..' || normalized.startsWith('/../') || normalized.includes('/../')) {
    const err = new Error('Invalid path');
    err.status = 400;
    err.code = 'INVALID_PATH';
    throw err;
  }

  return normalized;
}

// GET /api/v1/openclaw/workspace/files
// List workspace files (all authenticated users can view metadata)
router.get('/workspace/files', requireAuth, async (req, res, next) => {
  try {
    const { path: inputPath = '/', recursive = 'false' } = req.query;
    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);
    
    logger.info('Listing OpenClaw workspace files', { 
      userId: req.user.id, 
      role: req.user.role,
      path: workspacePath,
      recursive 
    });
    
    const data = await makeOpenClawRequest(
      'GET',
      `/files?path=${encodeURIComponent(workspacePath)}&recursive=${recursive}`
    );
    
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/workspace/files/content
// Read file content (admin/owner only)
router.get('/workspace/files/content', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { path: inputPath } = req.query;
    
    if (!inputPath) {
      return res.status(400).json({ 
        error: { message: 'Path parameter is required', status: 400 } 
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);
    
    logger.info('Reading OpenClaw workspace file', { 
      userId: req.user.id, 
      path: workspacePath
    });
    
    const data = await makeOpenClawRequest(
      'GET',
      `/files/content?path=${encodeURIComponent(workspacePath)}`
    );
    
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/workspace/files
// Create file (admin/owner only) - fails if file already exists
router.post('/workspace/files', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { path: inputPath, content, encoding = 'utf8' } = req.body;
    
    if (!inputPath || content === undefined) {
      return res.status(400).json({ 
        error: { message: 'Path and content are required', status: 400 } 
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);
    
    // Check if file already exists before creating
    try {
      await makeOpenClawRequest('GET', `/files/content?path=${encodeURIComponent(workspacePath)}`);
      
      // If we get here, file exists - reject creation
      logger.warn('Attempt to overwrite existing file blocked', {
        userId: req.user.id,
        userEmail: req.user.email,
        path: workspacePath,
        action: 'create_file_rejected'
      });
      
      return res.status(409).json({
        error: {
          message: `File already exists at path: ${workspacePath}`,
          status: 409,
          code: 'FILE_EXISTS'
        }
      });
    } catch (error) {
      // Error handling for existence check:
      // - 404 Not Found: File doesn't exist, proceed with creation
      // - OPENCLAW_SERVICE_ERROR: Service returned an error (could be 404 or other status),
      //   proceed and let workspace service handle it during creation
      // - Other errors: Unexpected errors (network, timeout, etc.), throw to propagate
      
      const isFileNotFound = error.status === 404;
      const isServiceError = error.code === 'OPENCLAW_SERVICE_ERROR';
      
      if (!isFileNotFound && !isServiceError) {
        // Unexpected error during existence check (network, timeout, etc.)
        // Propagate to error handler
        throw error;
      }
      
      // File doesn't exist (404) or service error - proceed with creation attempt
      // The workspace service will handle validation during the actual creation
    }
    
    logger.info('Creating OpenClaw workspace file', { 
      userId: req.user.id,
      userEmail: req.user.email,
      path: workspacePath,
      contentLength: content.length,
      action: 'create_file'
    });
    
    const data = await makeOpenClawRequest('POST', '/files', {
      path: workspacePath,
      content,
      encoding
    });
    
    res.status(201).json({ data });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/openclaw/workspace/files
// Update existing file (admin/owner only)
router.put('/workspace/files', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { path: inputPath, content, encoding = 'utf8' } = req.body;
    
    if (!inputPath || content === undefined) {
      return res.status(400).json({ 
        error: { message: 'Path and content are required', status: 400 } 
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);
    
    logger.info('Updating OpenClaw workspace file', { 
      userId: req.user.id, 
      path: workspacePath,
      contentLength: content.length 
    });
    
    const data = await makeOpenClawRequest('PUT', '/files', {
      path: workspacePath,
      content,
      encoding
    });
    
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/openclaw/workspace/files
// Delete file (admin/owner only)
router.delete('/workspace/files', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { path: inputPath } = req.query;
    
    if (!inputPath) {
      return res.status(400).json({ 
        error: { message: 'Path parameter is required', status: 400 } 
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);
    
    logger.info('Deleting OpenClaw workspace file', { 
      userId: req.user.id, 
      path: workspacePath
    });
    
    await makeOpenClawRequest('DELETE', `/files?path=${encodeURIComponent(workspacePath)}`);
    
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/workspace/status
// Get workspace sync status
router.get('/workspace/status', requireAuth, async (req, res, next) => {
  try {
    logger.info('Checking OpenClaw workspace status', { userId: req.user.id });
    
    const data = await makeOpenClawRequest('GET', '/status');
    
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

// Helper to calculate next purge time (3 AM Asia/Singapore = 19:00 UTC)
function getNextPurgeTime() {
  const now = new Date();
  const sgOffset = 8 * 60; // Singapore is UTC+8
  
  // Convert current time to Singapore timezone
  const nowSg = new Date(now.getTime() + (sgOffset * 60 * 1000));
  
  // Get today's 3 AM in Singapore
  const todayPurge = new Date(nowSg);
  todayPurge.setHours(3, 0, 0, 0);
  
  // If we're past 3 AM today, schedule for tomorrow
  let nextPurge = todayPurge;
  if (nowSg >= todayPurge) {
    nextPurge = new Date(todayPurge.getTime() + (24 * 60 * 60 * 1000));
  }
  
  // Convert back to UTC
  return new Date(nextPurge.getTime() - (sgOffset * 60 * 1000)).toISOString();
}

// GET /api/v1/openclaw/agents
// Get configured agents from OpenClaw config file (auto-discovery)
router.get('/agents', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching OpenClaw agents configuration', { userId: req.user.id });
    
    // Read the OpenClaw config file directly from the workspace service
    // This reads from the running OpenClaw instance at /openclaw.json
    // (copy of config in the workspace directory)
    try {
      const data = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      const config = JSON.parse(data.content);
      
      // Extract agents list from config and filter out human-only entries
      const agentsList = config?.agents?.list || [];
      const filteredAgents = agentsList.filter(agent => !agent.orgChart?.isHuman);
      
      // Transform to include workspace path info and add default COO if empty
      const agents = filteredAgents.length > 0 ? filteredAgents.map(agent => ({
        id: agent.id,
        name: agent.identity?.name || agent.name || agent.id,
        label: agent.identity?.name || agent.name || agent.id,
        description: agent.identity?.theme || `${agent.identity?.name || agent.id} workspace`,
        icon: agent.identity?.emoji || '🤖',
        workspace: agent.workspace,
        isDefault: agent.default === true
      })) : [
        // Fallback default agent if none configured
        {
          id: 'coo',
          name: 'COO',
          label: 'Chief Operating Officer',
          description: 'Operations and workflow management',
          icon: '📊',
          workspace: '/home/node/.openclaw/workspace-coo',
          isDefault: true
        }
      ];
      
      // Sort so default agent comes first
      agents.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        return 0;
      });
      
      res.json({ data: agents });
    } catch (readError) {
      // If config file can't be read, return default COO agent
      logger.warn('Could not read OpenClaw config from workspace service, using default agent', {
        error: readError.message,
        status: readError.status
      });
      
      res.json({
        data: [{
          id: 'coo',
          name: 'COO',
          label: 'Chief Operating Officer',
          description: 'Operations and workflow management',
          icon: '📊',
          workspace: '/home/node/.openclaw/workspace-coo',
          isDefault: true
        }]
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/org-chart
// Get organization chart configuration from workspace
router.get('/org-chart', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching org chart configuration from OpenClaw config', { userId: req.user.id });
    
    try {
      // Read openclaw.json instead of org-chart.json
      const data = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      const config = JSON.parse(data.content);
      
      // Basic validation
      if (!config || typeof config !== 'object') {
        return res.status(400).json({
          error: {
            message: 'Invalid OpenClaw config: must be a JSON object',
            status: 400,
            code: 'INVALID_CONFIG'
          }
        });
      }
      
      // Transform agents.list into leadership array (for actual OpenClaw agents)
      const agentsList = config?.agents?.list || [];
      const agentLeadership = agentsList
        .filter(agent => agent.orgChart) // Only include agents with orgChart data
        .map(agent => ({
          id: agent.id,
          title: agent.orgChart.title,
          label: agent.orgChart.label || `mosbot-${agent.id}`,
          displayName: agent.identity?.name || agent.orgChart.title,
          description: agent.orgChart.description,
          status: 'scaffolded',
          reportsTo: agent.orgChart.reportsTo
        }));
      
      // Get human-only leadership entries from orgChart.leadership (e.g., CEO)
      const humanLeadership = config?.orgChart?.leadership || [];
      
      // Merge both leadership sources
      const leadership = [...humanLeadership, ...agentLeadership];
      
      // Get departments and subagents from orgChart section
      const orgChartDepartments = config?.orgChart?.departments || [];
      const orgChartSubagents = config?.orgChart?.subagents || [];
      
      // Create a lookup map for subagents
      const subagentMap = {};
      orgChartSubagents.forEach(subagent => {
        subagentMap[subagent.id] = subagent;
      });
      
      // Transform departments to include full subagent data
      const departments = orgChartDepartments.map(dept => ({
        id: dept.id,
        name: dept.name,
        leadId: dept.leadId,
        description: dept.description,
        subagents: (dept.subagents || []).map(subagentId => {
          const subagent = subagentMap[subagentId];
          return subagent || {
            id: subagentId,
            displayName: subagentId,
            label: `mosbot-${subagentId}`,
            description: '',
            status: 'unknown'
          };
        })
      }));
      
      // Return in the same format the dashboard expects
      const validatedConfig = {
        version: 1,
        leadership,
        departments
      };
      
      res.json({ data: validatedConfig });
    } catch (readError) {
      // File not found or read error
      if (readError.status === 404) {
        return res.status(404).json({
          error: {
            message: 'OpenClaw configuration not found at /openclaw.json',
            status: 404,
            code: 'CONFIG_NOT_FOUND'
          }
        });
      }
      
      // Other errors (invalid JSON, service error, etc.)
      logger.warn('Failed to read OpenClaw config for org chart', {
        error: readError.message,
        status: readError.status
      });
      
      throw readError;
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/subagents
// Get running, queued, and completed subagents from OpenClaw workspace runtime files
router.get('/subagents', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching subagent status', { userId: req.user.id });
    
    const { getAllSubagents } = require('../services/subagentsRuntimeService');
    
    // Fetch all subagents using runtime service
    const { running, queued, completed } = await getAllSubagents();
    
    // Calculate retention metadata
    const completedRetentionDays = parseInt(process.env.SUBAGENT_RETENTION_DAYS, 10) || 30;
    const activityLogRetentionDays = parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS, 10) || 7;
    const nextPurgeAt = getNextPurgeTime();
    
    res.json({
      data: {
        running,
        queued,
        completed,
        retention: {
          completedRetentionDays,
          activityLogRetentionDays,
          nextPurgeAt
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
