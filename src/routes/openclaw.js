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
// Read file content (admin/owner for all paths, all authenticated users for /workspace/docs/**)
router.get('/workspace/files/content', requireAuth, async (req, res, next) => {
  try {
    const { path: inputPath } = req.query;
    
    if (!inputPath) {
      return res.status(400).json({ 
        error: { message: 'Path parameter is required', status: 400 } 
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);
    
    // Check if this is a docs path (accessible to all authenticated users)
    const isDocsPath = workspacePath === '/workspace/docs' || workspacePath.startsWith('/workspace/docs/');
    
    // For non-docs paths, require admin/owner/agent role
    if (!isDocsPath && !['admin', 'agent', 'owner'].includes(req.user?.role)) {
      return res.status(403).json({
        error: { message: 'Admin access required', status: 403 }
      });
    }
    
    logger.info('Reading OpenClaw workspace file', { 
      userId: req.user.id,
      userRole: req.user.role,
      path: workspacePath,
      isDocsPath
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
      
      // Extract agents list from config
      const agentsList = config?.agents?.list || [];
      const filteredAgents = agentsList;
      
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
          workspace: '/home/node/.openclaw/workspace',
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
        data: [
          {
            id: 'coo',
            name: 'COO',
            label: 'Chief Operating Officer',
            description: 'Operations and workflow management',
            icon: '📊',
            workspace: '/home/node/.openclaw/workspace',
            isDefault: true
          },
          {
            id: 'archived',
            name: 'Archived',
            label: 'Archived (Old Main)',
            description: 'Archived workspace files from previous iteration',
            icon: '📦',
            workspace: '/home/node/.openclaw/_archived_workspace_main',
            isDefault: false
          }
        ]
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
    logger.info('Fetching org chart configuration from workspace', { userId: req.user.id });
    
    try {
      // Read org-chart.json from workspace directory (separate from openclaw.json to avoid config validation issues)
      // Located in workspace/ so it can be updated at runtime via the workspace service file API
      const data = await makeOpenClawRequest('GET', '/files/content?path=/workspace/org-chart.json');
      const orgChart = JSON.parse(data.content);
      
      // Basic validation
      if (!orgChart || typeof orgChart !== 'object') {
        return res.status(400).json({
          error: {
            message: 'Invalid org chart config: must be a JSON object',
            status: 400,
            code: 'INVALID_CONFIG'
          }
        });
      }
      
      const leadership = orgChart.leadership || [];
      const orgChartDepartments = orgChart.departments || [];
      const orgChartSubagents = orgChart.subagents || [];
      
      // Enrich leadership entries with active status from OpenClaw agents config
      try {
        const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
        const config = JSON.parse(configData.content);
        const agentsList = config?.agents?.list || [];
        const activeAgentIds = new Set(agentsList.map(a => a.id));
        
        // Mark leadership entries as 'active' if they exist in OpenClaw's agents.list
        leadership.forEach(entry => {
          if (entry.status !== 'human' && activeAgentIds.has(entry.id)) {
            entry.status = 'active';
            // Enrich with model info from OpenClaw config
            const agent = agentsList.find(a => a.id === entry.id);
            if (agent) {
              entry.model = agent.model?.primary || null;
            }
          }
        });
      } catch (configError) {
        // If we can't read openclaw.json, still return org chart with original statuses
        logger.warn('Could not read OpenClaw config for agent status enrichment', {
          error: configError.message
        });
      }
      
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
        version: orgChart.version || 1,
        leadership,
        departments
      };
      
      res.json({ data: validatedConfig });
    } catch (readError) {
      // If org-chart.json not found, fall back to extracting from openclaw.json
      // This supports local dev and older configs that still embed orgChart in the main config
      if (readError.status === 404) {
        logger.info('org-chart.json not found, falling back to openclaw.json extraction');
        
        // Helper to extract org chart from an openclaw.json config object
        const extractOrgChart = (config) => {
          const agentsList = config?.agents?.list || [];
          const agentLeadership = agentsList
            .filter(agent => agent.orgChart)
            .map(agent => ({
              id: agent.id,
              title: agent.orgChart.title,
              label: agent.orgChart.label || `mosbot-${agent.id}`,
              displayName: agent.identity?.name || agent.orgChart.title,
              description: agent.orgChart.description,
              status: 'active',
              reportsTo: agent.orgChart.reportsTo,
              model: agent.model?.primary || null
            }));
          
          const humanLeadership = config?.orgChart?.leadership || [];
          const leadership = [...humanLeadership, ...agentLeadership];
          
          const orgChartDepartments = config?.orgChart?.departments || [];
          const orgChartSubagents = config?.orgChart?.subagents || [];
          
          const subagentMap = {};
          orgChartSubagents.forEach(subagent => {
            subagentMap[subagent.id] = subagent;
          });
          
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
          
          return { leadership, departments };
        };
        
        // Try multiple paths: workspace copy (may still have orgChart keys), then PVC root config
        const configPaths = ['/workspace/openclaw.json', '/openclaw.json'];
        
        for (const configPath of configPaths) {
          try {
            const configData = await makeOpenClawRequest('GET', `/files/content?path=${configPath}`);
            const config = JSON.parse(configData.content);
            const { leadership, departments } = extractOrgChart(config);
            
            // Only use this source if it actually has org chart data
            if (leadership.length > 0 || departments.length > 0) {
              logger.info('Extracted org chart from fallback config', { source: configPath });
              return res.json({
                data: { version: 1, leadership, departments }
              });
            }
          } catch (_err) {
            // Try next path
          }
        }
        
        // All sources exhausted
        logger.warn('Failed to read org chart from any source');
        return res.status(404).json({
          error: {
            message: 'Org chart configuration not found',
            status: 404,
            code: 'CONFIG_NOT_FOUND'
          }
        });
      }
      
      // Other errors (invalid JSON, service error, etc.)
      logger.warn('Failed to read org chart config', {
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

// GET /api/v1/openclaw/sessions
// Get active sessions from OpenClaw Gateway (running and queued)
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching active sessions from OpenClaw Gateway', { userId: req.user.id });
    
    const { sessionsList } = require('../services/openclawGatewayClient');
    
    // Get list of agent IDs to query
    // Try to read from OpenClaw config, fallback to common agent IDs
    let agentIds = ['main', 'coo', 'cto', 'cmo', 'cpo'];
    
    try {
      const data = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      const config = JSON.parse(data.content);
      const agentsList = config?.agents?.list || [];
      const configuredAgents = agentsList
        .map(agent => agent.id);
      
      if (configuredAgents.length > 0) {
        agentIds = ['main', ...configuredAgents];
      }
    } catch (configError) {
      logger.warn('Could not read agent config, using default agent list', {
        error: configError.message
      });
    }
    
    // Query sessions from each agent using the full agent session key format.
    // The sessionKey in /tools/invoke must be the full key (e.g., "agent:coo:main")
    // to run the tool in that agent's context and see that agent's session store.
    // We request ALL session kinds (main, cron, hook, group, node, other) so that
    // cron-triggered sessions and hook sessions are included alongside regular ones.
    const ALL_SESSION_KINDS = ['main', 'group', 'cron', 'hook', 'node', 'other'];
    
    const sessionPromises = agentIds.map(agentId => {
      // Use the full session key format: "agent:<agentId>:main" for non-main agents
      // For the "main" agent, just use "main" (the default)
      const sessionKey = agentId === 'main' ? 'main' : `agent:${agentId}:main`;
      
      return sessionsList({
        sessionKey,
        kinds: ALL_SESSION_KINDS,
        limit: 500,
        messageLimit: 1 // Include last message per session
      }).then(sessions => sessions)
      .catch(err => {
        logger.warn('Failed to fetch sessions for agent', { agentId, sessionKey, error: err.message });
        return [];
      });
    });
    
    const sessionArrays = await Promise.all(sessionPromises);
    const allSessions = sessionArrays.flat();
    
    // Deduplicate by sessionId (agents may share some sessions)
    const sessionMap = new Map();
    allSessions.forEach(session => {
      const sessionId = session.sessionId || session.id;
      if (sessionId && !sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, session);
      }
    });
    const sessions = Array.from(sessionMap.values());
    
    logger.info('Sessions received from OpenClaw Gateway', { 
      userId: req.user.id,
      sessionCount: sessions.length
    });
    
    // Status thresholds based on updatedAt
    // OpenClaw does not expose a real-time "busy/processing" flag via sessions_list.
    // We infer status from how recently the session was updated:
    //   running: updated within the last 2 minutes (likely actively processing)
    //   active:  updated within the last 30 minutes (recently used)
    //   idle:    updated more than 30 minutes ago
    const RUNNING_THRESHOLD_MS = 2 * 60 * 1000;  // 2 minutes
    const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000;   // 30 minutes
    const now = Date.now();
    
    // Transform sessions to match dashboard expectations
    const transformedSessions = sessions.map(session => {
      // Extract agent name from session key (e.g., "agent:main:cron:..." -> "main")
      let agentName = 'unknown';
      if (session.key) {
        const keyParts = session.key.split(':');
        if (keyParts.length >= 2 && keyParts[0] === 'agent') {
          agentName = keyParts[1];
        }
      }
      
      // Determine status based on updatedAt timestamp
      const updatedAtMs = session.updatedAt || 0;
      const timeSinceUpdate = now - updatedAtMs;
      let status;
      if (timeSinceUpdate <= RUNNING_THRESHOLD_MS) {
        status = 'running';  // Very recently updated - likely processing
      } else if (timeSinceUpdate <= ACTIVE_THRESHOLD_MS) {
        status = 'active';   // Recently used but not currently processing
      } else {
        status = 'idle';     // Not recently active
      }
      
      // Extract the actual model used from the last message (not the session default)
      // session.model is the session default (often claude-opus-4-6)
      // messages[0].model or messages[0].provider/model has the actual model used
      const lastMessage = session.messages?.[0] || null;
      let actualModel = null;
      if (lastMessage?.provider && lastMessage?.model) {
        actualModel = `${lastMessage.provider}/${lastMessage.model}`;
      } else if (lastMessage?.model) {
        // Message model is in format "moonshotai/kimi-k2.5" (provider/model from API)
        actualModel = lastMessage.model;
      }
      // Only use actual model from message; do not fall back to session default
      const model = actualModel || null;
      
      // Extract token usage from last message
      const usage = lastMessage?.usage || {};
      const inputTokens = (usage.input || 0) + (usage.cacheRead || 0);
      const outputTokens = usage.output || 0;
      const messageCost = usage.cost?.total || 0;
      
      // Context window usage
      const contextTokens = session.contextTokens || 0; // Total context window size
      const totalTokensUsed = session.totalTokens || 0; // Tokens currently in context
      const contextUsagePercent = contextTokens > 0 
        ? Math.round((totalTokensUsed / contextTokens) * 100 * 10) / 10 
        : 0;
      
      // Extract last message text content (truncated)
      let lastMessageText = null;
      if (lastMessage?.content) {
        if (typeof lastMessage.content === 'string') {
          lastMessageText = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
          // Find the text block (skip thinking blocks)
          const textBlock = lastMessage.content.find(c => c.type === 'text');
          lastMessageText = textBlock?.text || null;
        }
      }
      // Truncate to 200 chars
      if (lastMessageText && lastMessageText.length > 200) {
        lastMessageText = lastMessageText.substring(0, 200) + '...';
      }
      // OpenClaw strips HEARTBEAT_OK from replies; when a heartbeat run completes OK
      // the last message may be empty. Infer HEARTBEAT_OK for heartbeat sessions with
      // token usage but no visible reply.
      // Check displayName/sessionLabel first (explicit labels), then key as fallback
      const displayName = (session.displayName || session.sessionLabel || '').toString().toLowerCase();
      const sessionKey = (session.key || '').toString().toLowerCase();
      // Heartbeat sessions have explicit "heartbeat" in displayName/label, or key ends with ":heartbeat"
      const isHeartbeatSession = displayName.includes('heartbeat') || 
                                 sessionKey.endsWith(':heartbeat') ||
                                 sessionKey.includes(':heartbeat:');
      const hasUsage = inputTokens > 0 || outputTokens > 0;
      if (!lastMessageText && isHeartbeatSession && hasUsage) {
        lastMessageText = 'HEARTBEAT_OK';
      }
      
      return {
        id: session.sessionId || session.id,
        key: session.key || null,
        label: session.displayName || session.sessionLabel || session.sessionId || session.id,
        status,
        kind: session.kind || 'main',
        updatedAt: session.updatedAt || null,
        agent: agentName,
        model,
        // Token usage
        contextTokens,
        totalTokensUsed,
        contextUsagePercent,
        inputTokens,
        outputTokens,
        messageCost,
        // Last message
        lastMessage: lastMessageText,
        lastMessageRole: lastMessage?.role || null,
      };
    });
    
    // Sort by updatedAt descending (most recent first)
    transformedSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    
    logger.info('Returning sessions', { 
      userId: req.user.id,
      total: transformedSessions.length,
      running: transformedSessions.filter(s => s.status === 'running').length,
      active: transformedSessions.filter(s => s.status === 'active').length,
      idle: transformedSessions.filter(s => s.status === 'idle').length
    });
    
    res.json({
      data: transformedSessions
    });
  } catch (error) {
    // If OpenClaw Gateway is not configured, return empty array
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw Gateway not available for sessions, returning empty array', {
        userId: req.user.id
      });
      return res.json({ data: [] });
    }
    next(error);
  }
});

// GET /api/v1/openclaw/sessions/:sessionId/messages
// Get full message history for a specific session
router.get('/sessions/:sessionId/messages', requireAuth, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { key: sessionKey, limit = 50, includeTools = false } = req.query;
    
    logger.info('Fetching session message history', { 
      userId: req.user.id,
      sessionId,
      sessionKey,
      limit,
      includeTools
    });
    
    // sessionKey is required since sessionsHistory needs it
    if (!sessionKey) {
      return res.status(400).json({
        error: 'Session key is required as a query parameter (key=...)'
      });
    }
    
    const { sessionsHistory, sessionsList } = require('../services/openclawGatewayClient');
    
    // Fetch full message history
    const historyResult = await sessionsHistory({
      sessionKey,
      limit: parseInt(limit, 10),
      includeTools: includeTools === 'true' || includeTools === true
    });
    
    // Log raw result for debugging empty sessions with usage data
    logger.debug('sessionsHistory raw result', {
      sessionKey,
      resultType: Array.isArray(historyResult) ? 'array' : typeof historyResult,
      resultKeys: historyResult && typeof historyResult === 'object' ? Object.keys(historyResult) : null,
      isNull: historyResult === null,
      isUndefined: historyResult === undefined
    });
    
    // Check for forbidden response (agent-to-agent access disabled)
    if (historyResult?.details?.status === 'forbidden') {
      logger.warn('Agent-to-agent history access forbidden', {
        sessionKey,
        error: historyResult.details.error
      });
      
      return res.status(403).json({
        error: {
          message: 'Agent session history is not accessible. Agent-to-agent access is disabled in OpenClaw Gateway.',
          code: 'AGENT_TO_AGENT_DISABLED',
          hint: 'Enable agent-to-agent access by setting tools.agentToAgent.enabled=true in OpenClaw Gateway configuration',
          details: historyResult.details
        }
      });
    }
    
    // Ensure we have an array of messages
    // sessionsHistory may return different structures:
    // - Direct array: [...]
    // - { messages: [...] }
    // - { details: { messages: [...] } }
    let messages = [];
    if (Array.isArray(historyResult)) {
      messages = historyResult;
    } else if (historyResult && Array.isArray(historyResult.messages)) {
      messages = historyResult.messages;
    } else if (historyResult && historyResult.details && Array.isArray(historyResult.details.messages)) {
      messages = historyResult.details.messages;
    } else if (historyResult && typeof historyResult === 'object') {
      logger.warn('Unexpected sessionsHistory result structure', { 
        sessionKey,
        result: historyResult,
        resultKeys: Object.keys(historyResult)
      });
      messages = [];
    }
    
    logger.info('Session history loaded', { 
      userId: req.user.id,
      sessionKey,
      messageCount: messages.length,
      rawMessageCount: Array.isArray(historyResult) ? historyResult.length : 
                       historyResult?.messages?.length || 
                       historyResult?.details?.messages?.length || 0
    });
    
    // Also fetch session metadata to include in response
    // We need to query the agent's session list to get the full session details
    // Extract agent from sessionKey (e.g., "agent:coo:main" -> "coo")
    let agentSessionKey = 'main';
    if (sessionKey.startsWith('agent:')) {
      const keyParts = sessionKey.split(':');
      if (keyParts.length >= 2) {
        const agentId = keyParts[1];
        agentSessionKey = agentId === 'main' ? 'main' : `agent:${agentId}:main`;
      }
    }
    
    // Query the agent's session list to get full session metadata
    const sessions = await sessionsList({
      sessionKey: agentSessionKey,
      limit: 500,
      messageLimit: 0 // We don't need messages here, just metadata
    });
    
    // Find the session matching our sessionId
    const session = sessions.find(s => 
      (s.sessionId === sessionId) || (s.id === sessionId)
    );
    
    // Transform messages for the dashboard
    // Messages are returned in chronological order (oldest first)
    const transformedMessages = messages.map((msg, index) => {
      // Extract text content, handling both string and array formats
      let content = null;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Find text blocks (skip thinking blocks and tool calls)
        const textBlocks = msg.content.filter(c => c.type === 'text');
        content = textBlocks.map(c => c.text).join('\n\n');
      }
      
      // Build model string
      let model = null;
      if (msg.provider && msg.model) {
        model = `${msg.provider}/${msg.model}`;
      } else if (msg.model) {
        model = msg.model;
      }
      
      return {
        index,
        role: msg.role || 'unknown',
        content,
        model,
        provider: msg.provider || null,
        timestamp: msg.timestamp || null
      };
    });
    
    // Build session metadata for context
    let sessionMetadata = {
      id: sessionId,
      key: sessionKey,
      label: sessionId,
      agent: 'unknown',
      status: 'unknown'
    };
    
    if (session) {
      // Extract agent name from session key
      let agentName = 'unknown';
      if (session.key) {
        const keyParts = session.key.split(':');
        if (keyParts.length >= 2 && keyParts[0] === 'agent') {
          agentName = keyParts[1];
        }
      }
      
      // Determine status based on updatedAt
      const RUNNING_THRESHOLD_MS = 2 * 60 * 1000;  // 2 minutes
      const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000;  // 30 minutes
      const now = Date.now();
      const updatedAtMs = session.updatedAt || 0;
      const timeSinceUpdate = now - updatedAtMs;
      let status;
      if (timeSinceUpdate <= RUNNING_THRESHOLD_MS) {
        status = 'running';
      } else if (timeSinceUpdate <= ACTIVE_THRESHOLD_MS) {
        status = 'active';
      } else {
        status = 'idle';
      }
      
      sessionMetadata = {
        id: sessionId,
        key: session.key || sessionKey,
        label: session.displayName || session.sessionLabel || sessionId,
        agent: agentName,
        status,
        kind: session.kind || 'main',
        updatedAt: session.updatedAt || null,
        contextTokens: session.contextTokens || 0,
        totalTokensUsed: session.totalTokens || 0,
        contextUsagePercent: session.contextTokens > 0 
          ? Math.round((session.totalTokens / session.contextTokens) * 100 * 10) / 10 
          : 0
      };
    }
    
    logger.info('Returning session messages', {
      userId: req.user.id,
      sessionId,
      messageCount: transformedMessages.length
    });
    
    res.json({
      data: {
        messages: transformedMessages,
        session: sessionMetadata
      }
    });
  } catch (error) {
    // If OpenClaw Gateway is not configured, return empty array
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw Gateway not available for session messages, returning empty', {
        userId: req.user.id,
        sessionId: req.params.sessionId
      });
      return res.json({ 
        data: { 
          messages: [], 
          session: { 
            id: req.params.sessionId, 
            key: req.query.key || null,
            label: req.params.sessionId,
            agent: 'unknown',
            status: 'unknown'
          } 
        } 
      });
    }
    next(error);
  }
});

// GET /api/v1/openclaw/cron-jobs
// Get all scheduled/recurring jobs: gateway cron jobs + agent heartbeats from config
router.get('/cron-jobs', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching cron jobs from OpenClaw', { userId: req.user.id });

    // Fetch gateway cron jobs and config heartbeats in parallel
    const { cronList } = require('../services/openclawGatewayClient');

    // Get OpenClaw config for agent enrichment
    let openclawConfig = null;
    try {
      const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      openclawConfig = JSON.parse(configData.content);
    } catch (configErr) {
      logger.warn('Could not read OpenClaw config for agent enrichment', { error: configErr.message });
    }

    const [gatewayJobs, heartbeatJobs] = await Promise.all([
      // 1. Gateway scheduler jobs (orchestration, memory flush, etc.)
      cronList().catch(err => {
        if (err.code === 'SERVICE_NOT_CONFIGURED' || err.code === 'SERVICE_UNAVAILABLE') {
          return [];
        }
        logger.warn('Failed to fetch gateway cron jobs', { error: err.message });
        return [];
      }),

      // 2. Heartbeat configs from openclaw.json + runtime last-run data
      (async () => {
        try {
          const data = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
          const config = JSON.parse(data.content);
          const agentsList = config?.agents?.list || [];
          const agentsWithHeartbeat = agentsList.filter(agent => agent.heartbeat);

          // Read last heartbeat timestamps in parallel for each agent
          const heartbeatResults = await Promise.all(
            agentsWithHeartbeat.map(async (agent) => {
              const hb = agent.heartbeat;
              const intervalMs = parseInterval(hb.every);

              // Try to read the agent's last heartbeat file
              let lastRunAt = null;
              let nextRunAt = null;
              try {
                const workspaceBase = agent.workspace || `/home/node/.openclaw/workspace-${agent.id}`;
                // The workspace service mounts the state PVC at /workspace,
                // so agent workspace paths like /home/node/.openclaw/workspace-coo
                // are accessible at /workspace-coo relative to the workspace service root
                const relativePath = workspaceBase.replace(/^\/home\/node\/\.openclaw\//, '/');
                const hbData = await makeOpenClawRequest(
                  'GET',
                  `/files/content?path=${encodeURIComponent(`${relativePath}/runtime/heartbeat/last.json`)}`
                );
                if (hbData?.content) {
                  const parsed = JSON.parse(hbData.content);
                  if (parsed.lastHeartbeat) {
                    lastRunAt = parsed.lastHeartbeat;
                    if (intervalMs) {
                      nextRunAt = new Date(new Date(lastRunAt).getTime() + intervalMs).toISOString();
                    }
                  }
                }
              } catch (_hbReadError) {
                // Heartbeat file may not exist yet — that's fine
              }

              return {
                jobId: `heartbeat-${agent.id}`,
                name: `${agent.identity?.name || agent.id} Heartbeat`,
                description: `Periodic heartbeat for the ${agent.identity?.name || agent.id} agent.`,
                source: 'config',
                enabled: true,
                agentId: agent.id,
                agentEmoji: agent.identity?.emoji || null,
                sessionTarget: hb.session || 'main',
                schedule: {
                  kind: 'every',
                  everyMs: intervalMs,
                  label: hb.every,
                },
                payload: {
                  kind: 'heartbeat',
                  model: hb.model || null,
                  session: hb.session || 'main',
                  target: hb.target || 'last',
                  prompt: hb.prompt || null,
                  ackMaxChars: hb.ackMaxChars || 200,
                },
                delivery: {
                  mode: hb.target === 'last' ? 'announce (last)' : (hb.target || 'none'),
                },
                lastRunAt,
                nextRunAt,
              };
            })
          );

          return heartbeatResults;
        } catch (readError) {
          logger.warn('Could not read OpenClaw config for heartbeats', {
            error: readError.message,
          });
          return [];
        }
      })(),
    ]);

    // Normalize gateway jobs: map common OpenClaw field names to our schema
    // and compute nextRunAt from cron expressions / intervals when missing
    let CronExpressionParser = null;
    try { 
      CronExpressionParser = require('cron-parser').CronExpressionParser; 
    } catch (_) { 
      /* optional dependency */ 
    }

    if (gatewayJobs.length > 0) {
      logger.info('Raw gateway job sample (first job keys)', {
        keys: Object.keys(gatewayJobs[0]),
        sample: JSON.stringify(gatewayJobs[0]).slice(0, 500),
      });
    }
    const taggedGatewayJobs = gatewayJobs.map(job => {
      const normalized = {
        ...job,
        source: job.source || 'gateway',
      };

      // Normalize schedule object if missing but raw cron/expression/interval exists
      if (!normalized.schedule) {
        if (job.cron) {
          normalized.schedule = { kind: 'cron', expr: job.cron, tz: job.tz || job.timezone || null };
        } else if (job.expression) {
          normalized.schedule = { kind: 'cron', expr: job.expression, tz: job.tz || job.timezone || null };
        } else if (job.interval || job.every) {
          const intervalStr = job.interval || job.every;
          const intervalMs = parseInterval(intervalStr);
          normalized.schedule = { kind: 'every', everyMs: intervalMs, label: intervalStr };
        }
      }

      // Normalize lastRunAt — check state object (OpenClaw gateway format) first,
      // then common top-level field names
      if (!normalized.lastRunAt) {
        const state = job.state || {};
        if (state.lastRunAtMs) {
          normalized.lastRunAt = new Date(state.lastRunAtMs).toISOString();
        } else {
          normalized.lastRunAt = job.lastFiredAt || job.lastRanAt || job.lastRun || job.last_fired_at || null;
        }
      }

      // Normalize nextRunAt — check state object first, then common top-level field names
      if (!normalized.nextRunAt) {
        const state = job.state || {};
        if (state.nextRunAtMs) {
          normalized.nextRunAt = new Date(state.nextRunAtMs).toISOString();
        } else {
          normalized.nextRunAt = job.nextFireAt || job.nextRun || job.next_fire_at || null;
        }
      }

      // Compute nextRunAt from schedule if still missing
      if (!normalized.nextRunAt) {
        try {
          const sched = normalized.schedule || {};
          if (sched.kind === 'cron' && sched.expr && CronExpressionParser) {
            const options = {};
            options.tz = sched.tz || process.env.TIMEZONE || 'UTC';
            const interval = CronExpressionParser.parse(sched.expr, options);
            normalized.nextRunAt = interval.next().toISOString();
          } else if (sched.kind === 'every' && sched.everyMs && normalized.lastRunAt) {
            normalized.nextRunAt = new Date(
              new Date(normalized.lastRunAt).getTime() + sched.everyMs
            ).toISOString();
          }
        } catch (cronErr) {
          logger.warn('Could not compute nextRunAt for gateway job', {
            jobId: job.jobId || job.id || job.name,
            error: cronErr.message,
          });
        }
      }

      // Also normalize status from state object for badge display
      if (!normalized.status && job.state?.lastStatus) {
        normalized.status = job.state.lastStatus;
      }

      // Ensure payload.message is always set for dashboard display
      // (official format uses payload.text for systemEvent, payload.message for agentTurn)
      if (normalized.payload) {
        if (!normalized.payload.message && normalized.payload.text) {
          normalized.payload.message = normalized.payload.text;
        }
        if (!normalized.payload.message && normalized.payload.prompt) {
          normalized.payload.message = normalized.payload.prompt;
        }
      }

      return normalized;
    });

    // Enrich jobs with agent model information
    const agentsList = openclawConfig?.agents?.list || [];
    const enrichedJobs = [...taggedGatewayJobs, ...heartbeatJobs].map(job => {
      if (job.agentId && agentsList.length > 0) {
        const agent = agentsList.find(a => a.id === job.agentId);
        if (agent && agent.model) {
          return {
            ...job,
            agentModel: agent.model?.primary || agent.model || null
          };
        }
      }
      return job;
    });

    // Query cron sessions from OpenClaw to get actual execution data
    // (tokens, cost, model used, last message) instead of proxying from agent main sessions
    const { sessionsList } = require('../services/openclawGatewayClient');
    
    // Get unique agent IDs that have cron jobs (not heartbeat jobs, which use main sessions)
    const cronJobAgentIds = [...new Set(
      enrichedJobs
        .filter(j => j.source === 'gateway')
        .map(j => j.agentId)
        .filter(Boolean)
    )];

    // Query ALL sessions for each agent, then filter to cron kind in-memory
    // OpenClaw's sessions_list with kinds: ['cron'] returns empty, but querying all
    // sessions may include cron sessions tagged with kind: 'cron'
    let cronSessionsByAgent = new Map();
    if (cronJobAgentIds.length > 0) {
      try {
        const cronSessionPromises = cronJobAgentIds.map(async agentId => {
          const sessionKey = agentId === 'main' ? 'main' : `agent:${agentId}:main`;
          try {
            const allSessions = await sessionsList({
              sessionKey,
              // Don't filter by kinds — get all sessions and filter in-memory
              limit: 500,
              messageLimit: 1 // Include last message for usage data
            });
            // Filter to cron sessions (kind === 'cron' or key contains ':cron:')
            const cronSessions = allSessions.filter(s => 
              s.kind === 'cron' || (s.key && s.key.includes(':cron:'))
            );
            return { agentId, sessions: cronSessions };
          } catch (err) {
            logger.warn('Failed to fetch sessions for cron matching', { agentId, error: err.message });
            return { agentId, sessions: [] };
          }
        });

        const cronSessionResults = await Promise.all(cronSessionPromises);
        cronSessionResults.forEach(({ agentId, sessions }) => {
          cronSessionsByAgent.set(agentId, sessions);
        });

        const totalCronSessions = Array.from(cronSessionsByAgent.values()).flat().length;
        logger.info('Cron sessions fetched', {
          agentCount: cronJobAgentIds.length,
          totalSessions: totalCronSessions
        });

        // Log sample cron session if found
        if (totalCronSessions > 0) {
          const firstCronSession = Array.from(cronSessionsByAgent.values()).flat()[0];
          logger.info('Sample cron session', {
            key: firstCronSession.key,
            kind: firstCronSession.kind,
            updatedAt: firstCronSession.updatedAt,
            hasMessages: (firstCronSession.messages || []).length > 0
          });
        }
      } catch (cronSessionErr) {
        logger.warn('Failed to query sessions for cron matching, execution data will be unavailable', {
          error: cronSessionErr.message
        });
      }
    }

    // Merge execution data from cron sessions into each cron job
    // Note: OpenClaw runs cron jobs in isolated sessions that are not exposed via sessions_list,
    // so we provide basic state data from jobs.json and null for detailed metrics.
    const jobsWithExecutionData = enrichedJobs.map(job => {
      // Only enrich gateway cron jobs; heartbeats use main sessions
      if (job.source !== 'gateway' || !job.agentId) {
        return job;
      }

      const agentCronSessions = cronSessionsByAgent.get(job.agentId) || [];
      const jobLastRunMs = job.state?.lastRunAtMs;
      
      // Attempt to match a cron session by timestamp proximity (may be empty)
      let bestMatch = null;
      let bestMatchDelta = Infinity;

      if (agentCronSessions.length > 0 && jobLastRunMs) {
        agentCronSessions.forEach(session => {
          const sessionUpdatedAt = session.updatedAt || 0;
          const delta = Math.abs(sessionUpdatedAt - jobLastRunMs);
          // Allow up to 5 minute drift for matching
          if (delta < 5 * 60 * 1000 && delta < bestMatchDelta) {
            bestMatch = session;
            bestMatchDelta = delta;
          }
        });
      }

      if (bestMatch) {
        // Extract execution data from the matched session
        const lastMessage = bestMatch.messages?.[0] || null;
        const usage = lastMessage?.usage || {};
        const inputTokens = (usage.input || 0) + (usage.cacheRead || 0);
        const outputTokens = usage.output || 0;
        const messageCost = usage.cost?.total || 0;

        // Extract model from message
        let actualModel = null;
        if (lastMessage?.provider && lastMessage?.model) {
          actualModel = `${lastMessage.provider}/${lastMessage.model}`;
        } else if (lastMessage?.model) {
          actualModel = lastMessage.model;
        }

        // Extract last message text
        let lastMessageText = null;
        if (lastMessage?.content) {
          if (typeof lastMessage.content === 'string') {
            lastMessageText = lastMessage.content;
          } else if (Array.isArray(lastMessage.content)) {
            const textBlock = lastMessage.content.find(c => c.type === 'text');
            lastMessageText = textBlock?.text || null;
          }
        }
        if (lastMessageText && lastMessageText.length > 200) {
          lastMessageText = lastMessageText.substring(0, 200) + '...';
        }

        // Context window
        const contextTokens = bestMatch.contextTokens || 0;
        const totalTokensUsed = bestMatch.totalTokens || 0;
        const contextUsagePercent = contextTokens > 0 
          ? Math.round((totalTokensUsed / contextTokens) * 100 * 10) / 10 
          : 0;

        return {
          ...job,
          lastExecution: {
            inputTokens,
            outputTokens,
            messageCost,
            model: actualModel,
            lastMessage: lastMessageText,
            updatedAt: bestMatch.updatedAt,
            contextTokens,
            totalTokensUsed,
            contextUsagePercent,
            sessionKey: bestMatch.key || null,
          }
        };
      }

      // No session match found — provide basic state data from jobs.json
      // Include a flag indicating that detailed metrics are unavailable
      return {
        ...job,
        lastExecution: {
          inputTokens: null,
          outputTokens: null,
          messageCost: null,
          model: null,
          lastMessage: null,
          updatedAt: jobLastRunMs || null,
          contextTokens: null,
          totalTokensUsed: null,
          contextUsagePercent: null,
          sessionKey: null,
          durationMs: job.state?.lastDurationMs || null,
          status: job.state?.lastStatus || null,
          unavailable: true, // Flag indicating session data is not accessible
        }
      };
    });

    logger.info('Cron jobs aggregated', {
      userId: req.user.id,
      gateway: taggedGatewayJobs.length,
      heartbeats: heartbeatJobs.length,
      total: jobsWithExecutionData.length,
      withExecutionData: jobsWithExecutionData.filter(j => j.lastExecution).length,
    });

    res.json({ data: jobsWithExecutionData });
  } catch (error) {
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw not available for cron jobs, returning empty array', {
        userId: req.user.id,
      });
      return res.json({ data: [] });
    }
    next(error);
  }
});

// Helper: parse human interval strings like "30m", "60m", "2h" to milliseconds
function parseInterval(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * (multipliers[unit] || 60000);
}

// POST /api/v1/openclaw/cron-jobs
// Create a new gateway cron job (admin only)
router.post('/cron-jobs', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { createCronJob } = require('../services/cronJobsService');
    
    logger.info('Creating cron job', { 
      userId: req.user.id,
      name: req.body.name 
    });
    
    const job = await createCronJob(req.body);
    
    res.status(201).json({ data: job });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/openclaw/cron-jobs/:jobId
// Update an existing cron job (admin only)
// Supports both gateway jobs and heartbeat (config) jobs
router.put('/cron-jobs/:jobId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { updateCronJob, updateHeartbeatJob } = require('../services/cronJobsService');
    const { jobId } = req.params;
    
    logger.info('Updating cron job', { 
      userId: req.user.id,
      jobId,
      name: req.body.name 
    });
    
    // Check if this is a heartbeat job (jobId starts with 'heartbeat-')
    const isHeartbeat = jobId.startsWith('heartbeat-');
    
    let job;
    if (isHeartbeat) {
      job = await updateHeartbeatJob(jobId, req.body);
    } else {
      job = await updateCronJob(jobId, req.body);
    }
    
    res.json({ data: job });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/openclaw/cron-jobs/:jobId/enabled
// Toggle enabled state for a cron job (admin only)
// Note: Heartbeat jobs cannot be enabled/disabled via this endpoint
router.patch('/cron-jobs/:jobId/enabled', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { setCronJobEnabled } = require('../services/cronJobsService');
    const { jobId } = req.params;
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: { message: 'enabled must be a boolean', status: 400 }
      });
    }
    
    // Heartbeat jobs cannot be enabled/disabled separately
    if (jobId.startsWith('heartbeat-')) {
      return res.status(400).json({
        error: { 
          message: 'Heartbeat jobs cannot be enabled/disabled via this endpoint. Edit the heartbeat configuration instead.', 
          status: 400 
        }
      });
    }
    
    logger.info('Toggling cron job enabled state', { 
      userId: req.user.id,
      jobId,
      enabled 
    });
    
    const job = await setCronJobEnabled(jobId, enabled);
    
    res.json({ data: job });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/cron-jobs/:jobId/trigger
// Manually trigger a cron job to run now (admin only)
router.post('/cron-jobs/:jobId/trigger', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { triggerCronJob } = require('../services/cronJobsService');
    const { jobId } = req.params;

    logger.info('Manual cron job trigger requested', {
      userId: req.user.id,
      jobId,
    });

    const job = await triggerCronJob(jobId);

    res.json({
      data: job,
      meta: {
        message: 'Trigger requested. The job will fire within the next 60 seconds.',
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/openclaw/cron-jobs/:jobId
// Delete a gateway cron job (admin only)
// Note: Heartbeat jobs cannot be deleted (they're defined in OpenClaw config)
router.delete('/cron-jobs/:jobId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { deleteCronJob } = require('../services/cronJobsService');
    const { jobId } = req.params;
    
    // Heartbeat jobs cannot be deleted
    if (jobId.startsWith('heartbeat-')) {
      return res.status(400).json({
        error: { 
          message: 'Heartbeat jobs cannot be deleted. They are defined in OpenClaw configuration.', 
          status: 400 
        }
      });
    }
    
    logger.info('Deleting cron job', { 
      userId: req.user.id,
      jobId 
    });
    
    await deleteCronJob(jobId);
    
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
