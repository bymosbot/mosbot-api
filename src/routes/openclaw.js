const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const config = require('../config');
const logger = require('../utils/logger');
const path = require('path');
const pool = require('../db/pool');
const { requireAdmin } = require('./auth');
const { makeOpenClawRequest } = require('../services/openclawWorkspaceClient');
const { estimateCostFromTokens } = require('../services/modelPricingService');
const { recordActivityLogEventSafe } = require('../services/activityLogService');
const { parseOpenClawConfig } = require('../utils/configParser');
const { getJwtSecret } = require('../utils/jwt');

// Auth middleware - require valid JWT
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Authorization required', status: 401 },
    });
  }

  const token = authHeader.substring(7);

  let jwtSecret;
  try {
    jwtSecret = getJwtSecret();
  } catch (_err) {
    return res.status(500).json({ error: { message: 'Server configuration error', status: 500 } });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch (_err) {
    return res.status(401).json({
      error: { message: 'Invalid or expired token', status: 401 },
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

/**
 * Validate that a workspace path is allowed for access
 * @param {string} workspacePath - Normalized workspace path
 * @returns {boolean} - True if path is allowed
 */
function isAllowedWorkspacePath(workspacePath) {
  // Allow root
  if (workspacePath === '/') return true;

  // Allow system config files
  if (workspacePath === '/openclaw.json' || workspacePath === '/org-chart.json') return true;

  // Allow docs and projects directories (moved from /shared/docs and /shared/projects)
  if (workspacePath.startsWith('/docs/') || workspacePath === '/docs') return true;
  if (workspacePath.startsWith('/projects/') || workspacePath === '/projects') return true;
  // Allow other shared directories
  if (workspacePath.startsWith('/shared/scripts/') || workspacePath === '/shared/scripts')
    return true;

  // Allow skills directory (moved from /shared/skills to /skills)
  if (workspacePath.startsWith('/skills/') || workspacePath === '/skills') return true;

  // Allow agent workspaces
  if (workspacePath.startsWith('/workspace/') || workspacePath === '/workspace') return true;
  if (workspacePath.startsWith('/workspace-') || /^\/workspace-[a-z]+(\/|$)/.test(workspacePath))
    return true;

  return false;
}

/**
 * Normalize a timestamp from OpenClaw to milliseconds.
 * OpenClaw may return: ms number, seconds number, or ISO string.
 */
function toUpdatedAtMs(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') {
    // Values < 1e12 are likely Unix seconds
    return val < 1e12 ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const parsed = new Date(val).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// GET /api/v1/openclaw/workspace/files
// List workspace files (all authenticated users can view metadata)
router.get('/workspace/files', requireAuth, async (req, res, next) => {
  try {
    const { path: inputPath = '/', recursive = 'false' } = req.query;
    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);

    // Validate path is allowed
    if (!isAllowedWorkspacePath(workspacePath)) {
      return res.status(403).json({
        error: {
          message: 'Access denied: Path not allowed',
          status: 403,
          code: 'PATH_NOT_ALLOWED',
        },
      });
    }

    logger.info('Listing OpenClaw workspace files', {
      userId: req.user.id,
      role: req.user.role,
      path: workspacePath,
      recursive,
    });

    const data = await makeOpenClawRequest(
      'GET',
      `/files?path=${encodeURIComponent(workspacePath)}&recursive=${recursive}`,
    );

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/workspace/files/content
// Read file content (admin/owner for all paths, all authenticated users for /docs/**)
router.get('/workspace/files/content', requireAuth, async (req, res, next) => {
  try {
    const { path: inputPath } = req.query;

    if (!inputPath) {
      return res.status(400).json({
        error: { message: 'Path parameter is required', status: 400 },
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);

    // Validate path is allowed
    if (!isAllowedWorkspacePath(workspacePath)) {
      return res.status(403).json({
        error: {
          message: 'Access denied: Path not allowed',
          status: 403,
          code: 'PATH_NOT_ALLOWED',
        },
      });
    }

    // Check if this is a docs path (accessible to all authenticated users)
    // Docs live at /docs/ (moved from /shared/docs/)
    const isDocsPath = workspacePath === '/docs' || workspacePath.startsWith('/docs/');

    // For non-docs paths, require admin/owner/agent role
    if (!isDocsPath && !['admin', 'agent', 'owner'].includes(req.user?.role)) {
      return res.status(403).json({
        error: { message: 'Admin access required', status: 403 },
      });
    }

    logger.info('Reading OpenClaw workspace file', {
      userId: req.user.id,
      userRole: req.user.role,
      path: workspacePath,
      isDocsPath,
    });

    const data = await makeOpenClawRequest(
      'GET',
      `/files/content?path=${encodeURIComponent(workspacePath)}`,
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
        error: { message: 'Path and content are required', status: 400 },
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);

    // Restrict system config files to admin/owner only (exclude 'agent' role)
    const isSystemConfigFile =
      workspacePath === '/openclaw.json' || workspacePath === '/org-chart.json';
    if (isSystemConfigFile && req.user.role === 'agent') {
      logger.warn('Agent role blocked from modifying system config', {
        userId: req.user.id,
        userEmail: req.user.email,
        userRole: req.user.role,
        path: workspacePath,
        action: 'create_file_rejected',
      });

      return res.status(403).json({
        error: {
          message: 'System configuration files can only be modified by admin or owner roles',
          status: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        },
      });
    }

    // Check if file already exists before creating
    try {
      await makeOpenClawRequest('GET', `/files/content?path=${encodeURIComponent(workspacePath)}`);

      // If we get here, file exists - reject creation
      logger.warn('Attempt to overwrite existing file blocked', {
        userId: req.user.id,
        userEmail: req.user.email,
        path: workspacePath,
        action: 'create_file_rejected',
      });

      return res.status(409).json({
        error: {
          message: `File already exists at path: ${workspacePath}`,
          status: 409,
          code: 'FILE_EXISTS',
        },
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
      action: 'create_file',
    });

    const data = await makeOpenClawRequest('POST', '/files', {
      path: workspacePath,
      content,
      encoding,
    });

    recordActivityLogEventSafe({
      event_type: 'workspace_file_created',
      source: 'workspace',
      title: `File created: ${workspacePath}`,
      description: `User created workspace file at ${workspacePath}`,
      severity: 'info',
      actor_user_id: req.user.id,
      workspace_path: workspacePath,
      meta: { contentLength: content.length, encoding },
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
        error: { message: 'Path and content are required', status: 400 },
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);

    // Validate path is allowed
    if (!isAllowedWorkspacePath(workspacePath)) {
      return res.status(403).json({
        error: {
          message: 'Access denied: Path not allowed',
          status: 403,
          code: 'PATH_NOT_ALLOWED',
        },
      });
    }

    // Restrict system config files to admin/owner only (exclude 'agent' role)
    const isSystemConfigFile =
      workspacePath === '/openclaw.json' || workspacePath === '/org-chart.json';
    if (isSystemConfigFile && req.user.role === 'agent') {
      logger.warn('Agent role blocked from modifying system config', {
        userId: req.user.id,
        userEmail: req.user.email,
        userRole: req.user.role,
        path: workspacePath,
        action: 'update_file_rejected',
      });

      return res.status(403).json({
        error: {
          message: 'System configuration files can only be modified by admin or owner roles',
          status: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        },
      });
    }

    logger.info('Updating OpenClaw workspace file', {
      userId: req.user.id,
      path: workspacePath,
      contentLength: content.length,
    });

    const data = await makeOpenClawRequest('PUT', '/files', {
      path: workspacePath,
      content,
      encoding,
    });

    recordActivityLogEventSafe({
      event_type: 'workspace_file_updated',
      source: 'workspace',
      title: `File updated: ${workspacePath}`,
      description: `User updated workspace file at ${workspacePath}`,
      severity: 'info',
      actor_user_id: req.user.id,
      workspace_path: workspacePath,
      meta: { contentLength: content.length, encoding },
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
        error: { message: 'Path parameter is required', status: 400 },
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);

    // Validate path is allowed
    if (!isAllowedWorkspacePath(workspacePath)) {
      return res.status(403).json({
        error: {
          message: 'Access denied: Path not allowed',
          status: 403,
          code: 'PATH_NOT_ALLOWED',
        },
      });
    }

    // Restrict system config files to admin/owner only (exclude 'agent' role)
    const isSystemConfigFile =
      workspacePath === '/openclaw.json' || workspacePath === '/org-chart.json';
    if (isSystemConfigFile && req.user.role === 'agent') {
      logger.warn('Agent role blocked from deleting system config', {
        userId: req.user.id,
        userEmail: req.user.email,
        userRole: req.user.role,
        path: workspacePath,
        action: 'delete_file_rejected',
      });

      return res.status(403).json({
        error: {
          message: 'System configuration files can only be deleted by admin or owner roles',
          status: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        },
      });
    }

    logger.info('Deleting OpenClaw workspace file', {
      userId: req.user.id,
      path: workspacePath,
    });

    await makeOpenClawRequest('DELETE', `/files?path=${encodeURIComponent(workspacePath)}`);

    recordActivityLogEventSafe({
      event_type: 'workspace_file_deleted',
      source: 'workspace',
      title: `File deleted: ${workspacePath}`,
      description: `User deleted workspace file at ${workspacePath}`,
      severity: 'warning',
      actor_user_id: req.user.id,
      workspace_path: workspacePath,
    });

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
  const nowSg = new Date(now.getTime() + sgOffset * 60 * 1000);

  // Get today's 3 AM in Singapore
  const todayPurge = new Date(nowSg);
  todayPurge.setHours(3, 0, 0, 0);

  // If we're past 3 AM today, schedule for tomorrow
  let nextPurge = todayPurge;
  if (nowSg >= todayPurge) {
    nextPurge = new Date(todayPurge.getTime() + 24 * 60 * 60 * 1000);
  }

  // Convert back to UTC
  return new Date(nextPurge.getTime() - sgOffset * 60 * 1000).toISOString();
}

// GET /api/v1/openclaw/agents
// Get configured agents from OpenClaw config file (auto-discovery)
router.get('/agents', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching OpenClaw agents configuration', {
      userId: req.user.id,
    });

    // Read the OpenClaw config file directly from the workspace service
    // This reads from the running OpenClaw instance at /openclaw.json
    // (copy of config in the workspace directory)
    try {
      const data = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      const config = parseOpenClawConfig(data.content);

      // Extract agents list from config
      const agentsList = config?.agents?.list || [];
      const filteredAgents = agentsList;

      // Transform to include workspace path info and add default COO if empty
      let agents =
        filteredAgents.length > 0
          ? filteredAgents.map((agent) => ({
              id: agent.id,
              name: agent.identity?.name || agent.name || agent.id,
              label: agent.identity?.name || agent.name || agent.id,
              title: agent.identity?.title || null,
              description: agent.identity?.theme || `${agent.identity?.name || agent.id} workspace`,
              icon: agent.identity?.emoji || '🤖',
              workspace: agent.workspace,
              isDefault: agent.default === true,
            }))
          : [
              // Fallback default agent if none configured
              {
                id: 'coo',
                name: 'COO',
                label: 'Chief Operating Officer',
                title: null,
                description: 'Operations and workflow management',
                icon: '📊',
                workspace: '/home/node/.openclaw/workspace',
                isDefault: true,
              },
            ];

      // Enrich agent names from users table (users.name is the canonical display name)
      try {
        const pool = require('../db/pool');
        const agentIds = agents.map((a) => a.id);
        const result = await pool.query(
          'SELECT agent_id, name FROM users WHERE agent_id = ANY($1)',
          [agentIds],
        );
        const userNameMap = new Map(result.rows.map((r) => [r.agent_id, r.name]));
        agents = agents.map((agent) => {
          const userName = userNameMap.get(agent.id);
          if (!userName) return agent;
          return { ...agent, name: userName, label: userName };
        });
      } catch (dbErr) {
        logger.warn('Could not enrich agents with user names from DB', {
          error: dbErr.message,
        });
      }

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
        status: readError.status,
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
            isDefault: true,
          },
          {
            id: 'archived',
            name: 'Archived',
            label: 'Archived (Old Main)',
            description: 'Archived workspace files from previous iteration',
            icon: '📦',
            workspace: '/home/node/.openclaw/_archived_workspace_main',
            isDefault: false,
          },
        ],
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/org-chart
// Get organization chart configuration
router.get('/org-chart', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching org chart configuration', { userId: req.user.id });

    try {
      // Read org-chart.json from system level (alongside openclaw.json)
      // Can be updated at runtime via the workspace service file API
      const data = await makeOpenClawRequest('GET', '/files/content?path=/org-chart.json');
      const orgChart = JSON.parse(data.content);

      // Basic validation
      if (!orgChart || typeof orgChart !== 'object') {
        return res.status(400).json({
          error: {
            message: 'Invalid org chart config: must be a JSON object',
            status: 400,
            code: 'INVALID_CONFIG',
          },
        });
      }

      const leadership = orgChart.leadership || [];
      const orgChartDepartments = orgChart.departments || [];
      const orgChartSubagents = orgChart.subagents || [];

      // Enrich leadership entries with active status from OpenClaw agents config
      try {
        const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
        const config = parseOpenClawConfig(configData.content);
        const agentsList = config?.agents?.list || [];
        const activeAgentIds = new Set(agentsList.map((a) => a.id));

        // Mark leadership entries as 'active' if they exist in OpenClaw's agents.list
        leadership.forEach((entry) => {
          if (entry.status !== 'human' && activeAgentIds.has(entry.id)) {
            entry.status = 'active';
            // Enrich with model info from OpenClaw config
            const agent = agentsList.find((a) => a.id === entry.id);
            if (agent) {
              entry.model = agent.model?.primary || null;
            }
          }
        });
      } catch (configError) {
        // If we can't read openclaw.json, still return org chart with original statuses
        logger.warn('Could not read OpenClaw config for agent status enrichment', {
          error: configError.message,
        });
      }

      // Create a lookup map for subagents
      const subagentMap = {};
      orgChartSubagents.forEach((subagent) => {
        subagentMap[subagent.id] = subagent;
      });

      // Transform departments to include full subagent data
      const departments = orgChartDepartments.map((dept) => ({
        id: dept.id,
        name: dept.name,
        leadId: dept.leadId,
        description: dept.description,
        subagents: (dept.subagents || []).map((subagentId) => {
          const subagent = subagentMap[subagentId];
          return (
            subagent || {
              id: subagentId,
              displayName: subagentId,
              label: `mosbot-${subagentId}`,
              description: '',
              status: 'unknown',
            }
          );
        }),
      }));

      // Return in the same format the dashboard expects
      const validatedConfig = {
        version: orgChart.version || 1,
        leadership,
        departments,
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
            .filter((agent) => agent.orgChart)
            .map((agent) => ({
              id: agent.id,
              title: agent.orgChart.title,
              label: agent.orgChart.label || `mosbot-${agent.id}`,
              displayName: agent.identity?.name || agent.orgChart.title,
              description: agent.orgChart.description,
              status: 'active',
              reportsTo: agent.orgChart.reportsTo,
              model: agent.model?.primary || null,
            }));

          const humanLeadership = config?.orgChart?.leadership || [];
          const leadership = [...humanLeadership, ...agentLeadership];

          const orgChartDepartments = config?.orgChart?.departments || [];
          const orgChartSubagents = config?.orgChart?.subagents || [];

          const subagentMap = {};
          orgChartSubagents.forEach((subagent) => {
            subagentMap[subagent.id] = subagent;
          });

          const departments = orgChartDepartments.map((dept) => ({
            id: dept.id,
            name: dept.name,
            leadId: dept.leadId,
            description: dept.description,
            subagents: (dept.subagents || []).map((subagentId) => {
              const subagent = subagentMap[subagentId];
              return (
                subagent || {
                  id: subagentId,
                  displayName: subagentId,
                  label: `mosbot-${subagentId}`,
                  description: '',
                  status: 'unknown',
                }
              );
            }),
          }));

          return { leadership, departments };
        };

        // Try openclaw.json at system level as fallback for org chart data
        const configPaths = ['/openclaw.json'];

        for (const configPath of configPaths) {
          try {
            const configData = await makeOpenClawRequest(
              'GET',
              `/files/content?path=${configPath}`,
            );
            const config = JSON.parse(configData.content);
            const { leadership, departments } = extractOrgChart(config);

            // Only use this source if it actually has org chart data
            if (leadership.length > 0 || departments.length > 0) {
              logger.info('Extracted org chart from fallback config', {
                source: configPath,
              });
              return res.json({
                data: { version: 1, leadership, departments },
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
            code: 'CONFIG_NOT_FOUND',
          },
        });
      }

      // Other errors (invalid JSON, service error, etc.)
      logger.warn('Failed to read org chart config', {
        error: readError.message,
        status: readError.status,
      });

      throw readError;
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/openclaw/org-chart/agents/:agentId
// Update an existing agent's org chart + OpenClaw config (admin/owner only)
// The API handles syncing changes to both org-chart.json and openclaw.json internally.
router.put('/org-chart/agents/:agentId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const agentData = req.body;

    if (req.user.role === 'agent') {
      return res.status(403).json({
        error: {
          message: 'System configuration files can only be modified by admin or owner roles',
          status: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        },
      });
    }

    logger.info('Updating agent config', { userId: req.user.id, agentId });

    // Validate required fields
    if (!agentData.title || !agentData.displayName) {
      return res.status(400).json({
        error: { message: 'title and displayName are required', status: 400 },
      });
    }

    // Load current configs
    let orgChart;
    try {
      const orgChartData = await makeOpenClawRequest('GET', '/files/content?path=/org-chart.json');
      orgChart = JSON.parse(orgChartData.content);
    } catch (err) {
      if (err.status === 404) {
        orgChart = {
          version: 1,
          leadership: [],
          departments: [],
          subagents: [],
        };
      } else {
        throw err;
      }
    }

    const openclawData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
    const openclawConfig = parseOpenClawConfig(openclawData.content);

    // --- Update org-chart.json leadership ---
    let leadership = orgChart.leadership || [];
    const leadershipIndex = leadership.findIndex((l) => l.id === agentId);

    if (leadershipIndex < 0) {
      return res.status(404).json({
        error: {
          message: `Agent "${agentId}" not found in org chart`,
          status: 404,
          code: 'AGENT_NOT_FOUND',
        },
      });
    }

    // Update only the fields the form manages
    leadership[leadershipIndex] = {
      ...leadership[leadershipIndex],
      title: agentData.title,
      label: agentData.label || leadership[leadershipIndex].label,
      displayName: agentData.displayName,
      description: agentData.description || '',
      status: agentData.status || leadership[leadershipIndex].status,
      reportsTo: agentData.reportsTo || null,
    };
    orgChart.leadership = leadership;

    // --- Update openclaw.json agents.list (non-human only) ---
    const isHuman = (agentData.status || leadership[leadershipIndex].status) === 'human';
    if (!isHuman) {
      const agentsList = openclawConfig.agents?.list || [];
      const agentIndex = agentsList.findIndex((a) => a.id === agentId);

      if (agentIndex >= 0) {
        const existing = agentsList[agentIndex];

        // Merge identity
        if (agentData.identityName || agentData.identityTheme || agentData.identityEmoji) {
          existing.identity = {
            ...(existing.identity || {}),
            ...(agentData.identityName && { name: agentData.identityName }),
            ...(agentData.identityTheme !== undefined && {
              theme: agentData.identityTheme,
            }),
            ...(agentData.identityEmoji && {
              emoji: agentData.identityEmoji,
            }),
          };
        }

        // Merge workspace
        if (agentData.workspace) {
          existing.workspace = agentData.workspace;
        }

        // Merge model
        if (agentData.modelPrimary) {
          existing.model = {
            ...(existing.model || {}),
            primary: agentData.modelPrimary,
          };
          const fallbacks = [agentData.modelFallback1, agentData.modelFallback2].filter(Boolean);
          existing.model.fallbacks = fallbacks.length > 0 ? fallbacks : undefined;
        }

        // Remove orgChart key if present (not recognized by OpenClaw schema)
        delete existing.orgChart;

        // Heartbeat
        if (agentData.heartbeatEnabled === true) {
          existing.heartbeat = {
            ...(existing.heartbeat || {}),
            every: agentData.heartbeatEvery || existing.heartbeat?.every || '60m',
            session: existing.heartbeat?.session || 'main',
            target: existing.heartbeat?.target || 'last',
            prompt: existing.heartbeat?.prompt || undefined,
            ackMaxChars: existing.heartbeat?.ackMaxChars || 200,
          };
          // Only set model if explicitly provided and not empty
          // If heartbeatModel is null/undefined/empty, preserve existing model (if any)
          // If heartbeatModel is provided with a value, use it
          if (
            agentData.heartbeatModel !== undefined &&
            agentData.heartbeatModel !== null &&
            agentData.heartbeatModel !== ''
          ) {
            existing.heartbeat.model = agentData.heartbeatModel;
          }
          // Note: If heartbeatModel is not provided, existing.heartbeat.model is preserved via spread operator above
          delete existing.heartbeat.fallbacks;
        } else if (agentData.heartbeatEnabled === false) {
          delete existing.heartbeat;
        }

        if (!openclawConfig.agents) openclawConfig.agents = {};
        openclawConfig.agents.list = agentsList;
      }
      // If agent doesn't exist in openclaw config, that's OK -- it stays as-is
    }

    // --- Clean up any stale orgChart keys from all agents (schema hygiene) ---
    const allAgents = openclawConfig.agents?.list || [];
    for (const agent of allAgents) {
      delete agent.orgChart;
    }

    // --- Write both files ---
    const orgChartContent = JSON.stringify(orgChart, null, 2) + '\n';
    const openclawContent = JSON.stringify(openclawConfig, null, 2) + '\n';

    await Promise.all([
      makeOpenClawRequest('PUT', '/files', {
        path: '/org-chart.json',
        content: orgChartContent,
        encoding: 'utf8',
      }),
      makeOpenClawRequest('PUT', '/files', {
        path: '/openclaw.json',
        content: openclawContent,
        encoding: 'utf8',
      }),
    ]);

    logger.info('Agent config updated successfully', {
      userId: req.user.id,
      agentId,
      orgChartSize: orgChartContent.length,
      openclawSize: openclawContent.length,
    });

    recordActivityLogEventSafe({
      event_type: 'org_chart_agent_updated',
      source: 'org',
      title: `Agent updated: ${agentId}`,
      description: `Org chart and OpenClaw config updated for agent "${agentId}"`,
      severity: 'info',
      actor_user_id: req.user.id,
      agent_id: agentId,
      meta: { agentData },
    });

    res.json({
      data: {
        agentId,
        message: 'Agent updated successfully',
        updatedFiles: ['/org-chart.json', '/openclaw.json'],
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/org-chart/agents
// Create a new agent in the org chart + OpenClaw config (admin/owner only)
router.post('/org-chart/agents', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const agentData = req.body;

    if (req.user.role === 'agent') {
      return res.status(403).json({
        error: {
          message: 'System configuration files can only be modified by admin or owner roles',
          status: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        },
      });
    }

    // Validate required fields
    if (!agentData.id || !agentData.title || !agentData.displayName) {
      return res.status(400).json({
        error: {
          message: 'id, title, and displayName are required',
          status: 400,
        },
      });
    }

    logger.info('Creating agent', {
      userId: req.user.id,
      agentId: agentData.id,
    });

    // Load current configs
    let orgChart;
    try {
      const orgChartData = await makeOpenClawRequest('GET', '/files/content?path=/org-chart.json');
      orgChart = JSON.parse(orgChartData.content);
    } catch (err) {
      if (err.status === 404) {
        orgChart = {
          version: 1,
          leadership: [],
          departments: [],
          subagents: [],
        };
      } else {
        throw err;
      }
    }

    const openclawData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
    const openclawConfig = JSON.parse(openclawData.content);

    // Check for duplicates
    const leadership = orgChart.leadership || [];
    if (leadership.some((l) => l.id === agentData.id)) {
      return res.status(409).json({
        error: {
          message: `Agent "${agentData.id}" already exists in org chart`,
          status: 409,
          code: 'AGENT_EXISTS',
        },
      });
    }

    // --- Add to org-chart.json leadership ---
    leadership.push({
      id: agentData.id,
      title: agentData.title,
      label: agentData.label || `mosbot-${agentData.id}`,
      displayName: agentData.displayName,
      description: agentData.description || '',
      status: agentData.status || 'scaffolded',
      reportsTo: agentData.reportsTo || null,
    });
    orgChart.leadership = leadership;

    // --- Add to openclaw.json agents.list (non-human only) ---
    const isHuman = agentData.status === 'human';
    if (!isHuman) {
      if (!openclawConfig.agents) openclawConfig.agents = {};
      if (!Array.isArray(openclawConfig.agents.list)) openclawConfig.agents.list = [];

      const fallbacks = [agentData.modelFallback1, agentData.modelFallback2].filter(Boolean);

      const newAgent = {
        id: agentData.id,
        workspace: agentData.workspace || `/home/node/.openclaw/workspace-${agentData.id}`,
        identity: {
          name: agentData.identityName || agentData.displayName,
          theme: agentData.identityTheme || agentData.description || '',
          emoji: agentData.identityEmoji || '🤖',
        },
        model: {
          primary: agentData.modelPrimary || 'openrouter/anthropic/claude-sonnet-4.5',
          fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
        },
      };

      if (agentData.heartbeatEnabled) {
        newAgent.heartbeat = {
          every: agentData.heartbeatEvery || '60m',
          session: 'main',
          target: 'last',
          ackMaxChars: 200,
        };
        // Only set model if explicitly provided and not empty
        // If heartbeatModel is null/undefined/empty, don't set it (OpenClaw will use agent's primary model)
        if (agentData.heartbeatModel && agentData.heartbeatModel !== '') {
          newAgent.heartbeat.model = agentData.heartbeatModel;
        }
      }

      openclawConfig.agents.list.push(newAgent);
    }

    // --- Write both files ---
    const orgChartContent = JSON.stringify(orgChart, null, 2) + '\n';
    const openclawContent = JSON.stringify(openclawConfig, null, 2) + '\n';

    await Promise.all([
      makeOpenClawRequest('PUT', '/files', {
        path: '/org-chart.json',
        content: orgChartContent,
        encoding: 'utf8',
      }),
      makeOpenClawRequest('PUT', '/files', {
        path: '/openclaw.json',
        content: openclawContent,
        encoding: 'utf8',
      }),
    ]);

    logger.info('Agent created successfully', {
      userId: req.user.id,
      agentId: agentData.id,
      orgChartSize: orgChartContent.length,
      openclawSize: openclawContent.length,
    });

    recordActivityLogEventSafe({
      event_type: 'org_chart_agent_created',
      source: 'org',
      title: `Agent created: ${agentData.id}`,
      description: `New agent "${agentData.displayName}" (${agentData.id}) added to org chart`,
      severity: 'info',
      actor_user_id: req.user.id,
      agent_id: agentData.id,
      meta: {
        displayName: agentData.displayName,
        title: agentData.title,
        status: agentData.status,
      },
    });

    res.status(201).json({
      data: {
        agentId: agentData.id,
        message: 'Agent created successfully',
        updatedFiles: ['/org-chart.json', '/openclaw.json'],
      },
    });
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
    const completedRetentionDays = config.openclaw.subagentRetentionDays;
    const activityLogRetentionDays = config.openclaw.activityLogRetentionDays;
    const nextPurgeAt = getNextPurgeTime();

    res.json({
      data: {
        running,
        queued,
        completed,
        retention: {
          completedRetentionDays,
          activityLogRetentionDays,
          nextPurgeAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/sessions
// Get active sessions from OpenClaw Gateway (running and queued)
// GET /api/v1/openclaw/sessions/status
// Lightweight session counts for the global sidebar avatar.
// Only calls sessions.list (no usage/cost enrichment) to keep latency low.
router.get('/sessions/status', requireAuth, async (req, res, next) => {
  try {
    const { sessionsListAllViaWs } = require('../services/openclawGatewayClient');

    const RUNNING_THRESHOLD_MS = 2 * 60 * 1000;
    const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000;
    const now = Date.now();

    let sessions = [];
    try {
      const wsResult = await sessionsListAllViaWs({
        includeGlobal: true,
        includeUnknown: false,
        activeMinutes: 0,
        limit: 0,
      });
      if (Array.isArray(wsResult)) {
        sessions = wsResult;
      } else if (wsResult?.sessions && Array.isArray(wsResult.sessions)) {
        sessions = wsResult.sessions;
      }
    } catch (wsErr) {
      logger.warn('sessions/status: WebSocket sessions.list failed', {
        error: wsErr.message,
      });
      // Return zeroed counts rather than erroring — avatar degrades gracefully
      return res.json({ data: { running: 0, active: 0, idle: 0, total: 0 } });
    }

    let running = 0,
      active = 0,
      idle = 0;
    for (const s of sessions) {
      const updatedAtMs = toUpdatedAtMs(s.updatedAt ?? s.updated_at);
      const age = now - updatedAtMs;
      if (age <= RUNNING_THRESHOLD_MS) running++;
      else if (age <= ACTIVE_THRESHOLD_MS) active++;
      else idle++;
    }

    return res.json({
      data: { running, active, idle, total: sessions.length },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching active sessions from OpenClaw Gateway', {
      userId: req.user.id,
    });

    const {
      sessionsListAllViaWs,
      sessionsList,
      gatewayWsRpc,
    } = require('../services/openclawGatewayClient');
    const { upsertSessionUsageBatch } = require('../services/sessionUsageService');

    // Primary: use the gateway's native WebSocket RPC sessions.list which has global
    // visibility across all agents, including subagent sessions (kind: subagent).
    // The /tools/invoke sessions_list tool is scoped per-agent and cannot see subagents.
    let sessions = [];
    let usedWsFallback = false;

    try {
      const wsResult = await sessionsListAllViaWs({
        includeGlobal: true,
        includeUnknown: true,
        activeMinutes: 0,
        limit: 0,
      });
      // sessions.list RPC returns { sessions: [...], count: N } or may return array directly
      // Handle both formats for compatibility with different OpenClaw versions
      if (Array.isArray(wsResult)) {
        sessions = wsResult;
      } else if (wsResult?.sessions && Array.isArray(wsResult.sessions)) {
        sessions = wsResult.sessions;
      } else {
        sessions = [];
      }
      logger.info('Sessions fetched via WebSocket RPC', {
        count: sessions.length,
        wsResultType: Array.isArray(wsResult) ? 'array' : typeof wsResult,
        hasSessionsProperty: wsResult?.sessions !== undefined,
        wsResultKeys: wsResult && typeof wsResult === 'object' ? Object.keys(wsResult) : null,
      });

      // If we got an empty result, log the raw response for debugging
      if (sessions.length === 0 && wsResult) {
        logger.warn('WebSocket RPC returned empty sessions array', {
          wsResultType: typeof wsResult,
          wsResultIsArray: Array.isArray(wsResult),
          wsResultKeys: wsResult && typeof wsResult === 'object' ? Object.keys(wsResult) : null,
          wsResultSample:
            wsResult && typeof wsResult === 'object'
              ? JSON.stringify(wsResult).substring(0, 200)
              : String(wsResult).substring(0, 200),
        });
      }

      // Enrich sessions with cost data from sessions.usage + usage.cost
      if (sessions.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        try {
          const [usageResult, costResult] = await Promise.all([
            gatewayWsRpc('sessions.usage', {
              startDate: today,
              endDate: today,
              limit: 1000,
            }),
            gatewayWsRpc('usage.cost', { startDate: today, endDate: today }),
          ]);
          // Per-session cost + token enrichment from sessions.usage
          if (usageResult?.sessions) {
            const usageMap = new Map();
            for (const us of usageResult.sessions) {
              const u = us.usage || {};
              usageMap.set(us.key, {
                totalCost: u.totalCost || 0,
                input: u.input || 0,
                output: u.output || 0,
                cacheRead: u.cacheRead || 0,
                cacheWrite: u.cacheWrite || 0,
              });
            }
            // Build session metadata map (agent_key, model) for session_usage enrichment
            const sessionMetaByKey = new Map();
            for (const s of sessions) {
              if (!s.key) continue;
              let agentKey = 'main';
              if (s.key.startsWith('agent:')) {
                const parts = s.key.split(':');
                if (parts.length >= 2) agentKey = parts[1];
              }
              let model = null;
              if (s.modelProvider && s.model) {
                // Normalize double prefixes (e.g., "openrouter/openrouter/..." -> "openrouter/...")
                let normalizedModel = s.model.trim();
                const doublePrefixMatch = normalizedModel.match(/^([^/]+)\/\1\/(.+)$/);
                if (doublePrefixMatch) {
                  const [, prefix, rest] = doublePrefixMatch;
                  normalizedModel = `${prefix}/${rest}`;
                }
                // Check if model already starts with the provider prefix to avoid duplication
                if (normalizedModel.startsWith(`${s.modelProvider.trim()}/`)) {
                  model = normalizedModel;
                } else {
                  model = `${s.modelProvider}/${normalizedModel}`;
                }
              } else if (s.model && typeof s.model === 'string') {
                model = s.model;
              } else {
                const lastMsg = s.messages?.[0];
                if (lastMsg?.provider && lastMsg?.model) {
                  // Normalize double prefixes
                  let normalizedModel = lastMsg.model.trim();
                  const doublePrefixMatch = normalizedModel.match(/^([^/]+)\/\1\/(.+)$/);
                  if (doublePrefixMatch) {
                    const [, prefix, rest] = doublePrefixMatch;
                    normalizedModel = `${prefix}/${rest}`;
                  }
                  // Check if model already starts with the provider prefix
                  if (normalizedModel.startsWith(`${lastMsg.provider.trim()}/`)) {
                    model = normalizedModel;
                  } else {
                    model = `${lastMsg.provider}/${normalizedModel}`;
                  }
                } else if (lastMsg?.model) {
                  model = lastMsg.model;
                }
              }
              sessionMetaByKey.set(s.key, { agentKey, model });
            }
            for (const s of sessions) {
              if (s.key && usageMap.has(s.key)) {
                const ud = usageMap.get(s.key);
                s._totalCost = ud.totalCost;
                s._usageInput = ud.input;
                s._usageOutput = ud.output;
                s._cacheRead = ud.cacheRead;
                s._cacheWrite = ud.cacheWrite;
              }
            }

            // For cron sessions: find the latest individual run from sessions.usage
            // so we show per-run token/cost data instead of the daily aggregate total.
            // Mirrors the same logic used in the cron-jobs endpoint.
            // Group by parent key and separate :run: entries from parent entries
            // to avoid using cumulative parent values as per-run data.
            const cronBuckets = new Map(); // parentKey -> { runs: [], parent: null }
            for (const us of usageResult.sessions) {
              if (!us.key || !us.key.includes(':cron:')) continue;
              const u = us.usage || {};
              // lastActivity might be on us itself or in us.usage
              const lastActivity = us.lastActivity ?? u.lastActivity ?? null;
              const runIdx = us.key.indexOf(':run:');
              const isRun = runIdx !== -1;
              const parentKey = isRun ? us.key.slice(0, runIdx) : us.key;
              if (!cronBuckets.has(parentKey)) {
                cronBuckets.set(parentKey, { runs: [], parent: null });
              }
              const bucket = cronBuckets.get(parentKey);
              if (isRun) {
                bucket.runs.push({ ...u, lastActivity, _runKey: us.key });
              } else {
                bucket.parent = { ...u, lastActivity, _runKey: us.key };
              }
            }
            const cronLatestRunMap = new Map();
            for (const [parentKey, bucket] of cronBuckets) {
              const hasRuns = bucket.runs.length > 0;
              const candidates = hasRuns ? bucket.runs : bucket.parent ? [bucket.parent] : [];
              let latest = null;
              for (const u of candidates) {
                if (!latest || (u.lastActivity || 0) > (latest.lastActivity || 0)) {
                  latest = u;
                }
              }
              if (latest) {
                let isCumul = !hasRuns;
                if (hasRuns && bucket.runs.length === 1) {
                  const userMsgs = bucket.runs[0]?.messageCounts?.user || 0;
                  if (userMsgs > 1) isCumul = true;
                }
                cronLatestRunMap.set(parentKey, {
                  ...latest,
                  _isCumulative: isCumul,
                });
              }
            }
            for (const s of sessions) {
              if (!s.key || !s.key.includes(':cron:')) continue;
              const runIdx = s.key.indexOf(':run:');
              const parentKey = runIdx !== -1 ? s.key.slice(0, runIdx) : s.key;
              const latestRun = cronLatestRunMap.get(parentKey);
              // totalTokens on the parent session (sessions.list) is the context window state
              // after the last run completed. Run sub-sessions don't appear in sessions.list.
              // Use the parent session's totalTokens as the context fill for the last run.
              if (latestRun) {
                s._cronLatestRun = {
                  ...latestRun,
                  totalTokens: s.totalTokens ?? 0,
                };
              }
            }

            // Enrich usage records with agent_key and model for session_usage persistence
            const enrichedUsage = usageResult.sessions.map((us) => {
              const meta = sessionMetaByKey.get(us.key);
              return {
                ...us,
                agent_key: meta?.agentKey,
                model: meta?.model ?? undefined,
              };
            });
            // Persist latest usage totals to session_usage table (fire-and-forget)
            upsertSessionUsageBatch(enrichedUsage).catch((err) => {
              logger.warn('Failed to persist session usage from sessions endpoint', {
                error: err.message,
              });
            });
          }
          // Store aggregate daily cost for the response
          sessions._dailyCost = costResult?.totals?.totalCost || 0;
        } catch (costErr) {
          logger.warn('Failed to fetch session cost data', {
            error: costErr.message,
          });
        }
      }
    } catch (wsErr) {
      logger.warn('WebSocket sessions.list failed, falling back to per-agent tool invocation', {
        error: wsErr.message,
        errorCode: wsErr.code,
        errorStatus: wsErr.status,
        stack: wsErr.stack,
      });
      usedWsFallback = true;
    }

    // Fallback: per-agent sessions_list tool invocation (does not include subagent sessions)
    if (usedWsFallback) {
      let agentIds = ['main', 'coo', 'cto', 'cmo', 'cpo'];
      try {
        const data = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
        const config = JSON.parse(data.content);
        const agentsList = config?.agents?.list || [];
        const configuredAgents = agentsList.map((agent) => agent.id);
        if (configuredAgents.length > 0) {
          agentIds = ['main', ...configuredAgents];
        }
      } catch (configError) {
        logger.warn('Could not read agent config, using default agent list', {
          error: configError.message,
        });
      }

      const ALL_SESSION_KINDS = ['main', 'group', 'cron', 'hook', 'node', 'subagent', 'other'];
      const sessionPromises = agentIds.map((agentId) => {
        const sessionKey = agentId === 'main' ? 'main' : `agent:${agentId}:main`;
        return sessionsList({
          sessionKey,
          kinds: ALL_SESSION_KINDS,
          limit: 500,
          messageLimit: 1,
        }).catch((err) => {
          logger.warn('Failed to fetch sessions for agent', {
            agentId,
            sessionKey,
            error: err.message,
          });
          return [];
        });
      });

      const sessionArrays = await Promise.all(sessionPromises);
      const allSessions = sessionArrays.flat();

      logger.info('Fallback sessions fetched', {
        agentCount: agentIds.length,
        totalSessionsBeforeDedup: allSessions.length,
        sessionsPerAgent: sessionArrays.map((arr, idx) => ({
          agentId: agentIds[idx],
          count: arr.length,
        })),
      });

      const sessionMap = new Map();
      let skippedNoId = 0;
      allSessions.forEach((session) => {
        // Use key as primary identifier (most reliable), fallback to sessionId/id
        const sessionId = session.key || session.sessionId || session.id;
        if (sessionId) {
          if (!sessionMap.has(sessionId)) {
            sessionMap.set(sessionId, session);
          }
        } else {
          skippedNoId++;
          // Log first few skipped sessions for debugging
          if (skippedNoId <= 3) {
            logger.debug('Session skipped (no id/key)', {
              sessionKeys: Object.keys(session),
              sessionSample: JSON.stringify(session).substring(0, 200),
            });
          }
        }
      });
      sessions = Array.from(sessionMap.values());

      if (skippedNoId > 0) {
        logger.warn('Skipped sessions without id/key in fallback', {
          skippedCount: skippedNoId,
        });
      }

      logger.info('Fallback sessions after deduplication', {
        totalSessions: sessions.length,
        uniqueSessionIds: sessionMap.size,
      });
    }

    // When using WebSocket RPC, sessions don't include message history.
    // Fetch last message for each session via sessions_list tool (per-session).
    // For now, sessions from WS RPC won't have message data — the transform below
    // handles missing message data gracefully (model/tokens fall back to session-level fields).

    logger.info('Sessions received from OpenClaw Gateway', {
      userId: req.user.id,
      sessionCount: sessions.length,
    });

    // Debug: Log sample Telegram group session structure for topic extraction debugging
    const telegramGroupSample = sessions.find(
      (s) =>
        s.key &&
        typeof s.key === 'string' &&
        s.key.includes('telegram:group') &&
        s.key.includes('topic'),
    );
    if (telegramGroupSample) {
      logger.debug('Sample Telegram group session with topic', {
        key: telegramGroupSample.key,
        label: telegramGroupSample.label,
        name: telegramGroupSample.name,
        displayName: telegramGroupSample.displayName,
        topic: telegramGroupSample.topic,
        topicName: telegramGroupSample.topicName,
        lastChannel: telegramGroupSample.lastChannel,
        channel: telegramGroupSample.channel,
        lastMessage: telegramGroupSample.messages?.[0]
          ? {
              to: telegramGroupSample.messages[0].to,
              topic: telegramGroupSample.messages[0].topic,
              topicName: telegramGroupSample.messages[0].topicName,
            }
          : null,
      });
    }

    // Status thresholds based on updatedAt
    // OpenClaw does not expose a real-time "busy/processing" flag via sessions_list.
    // We infer status from how recently the session was updated:
    //   running: updated within the last 2 minutes (likely actively processing)
    //   active:  updated within the last 30 minutes (recently used)
    //   idle:    updated more than 30 minutes ago
    const RUNNING_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
    const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    // Transform sessions to match dashboard expectations
    const transformedSessions = sessions.map((session) => {
      // Extract agent name from session key (e.g., "agent:main:cron:..." -> "main")
      let agentName = 'unknown';
      if (session.key) {
        const keyParts = session.key.split(':');
        if (keyParts.length >= 2 && keyParts[0] === 'agent') {
          agentName = keyParts[1];
        }
      }

      // Determine status based on updatedAt timestamp
      // Support updatedAt (camelCase) or updated_at (snake_case) from OpenClaw
      // For cron sessions: prefer _cronLatestRun.lastActivity (when last run actually happened)
      // over session.updatedAt (which reflects session metadata updates, not run activity)
      let rawUpdatedAt = session.updatedAt ?? session.updated_at;
      if (session._cronLatestRun?.lastActivity) {
        // Use the last run's activity timestamp for cron sessions
        rawUpdatedAt = session._cronLatestRun.lastActivity;
      } else if (session.kind === 'cron' && session.messages?.[0]?.timestamp) {
        // Fallback: use last message timestamp for cron sessions if lastActivity isn't available
        rawUpdatedAt = session.messages[0].timestamp;
      }
      const updatedAtMs = toUpdatedAtMs(rawUpdatedAt);
      const timeSinceUpdate = now - updatedAtMs;
      let status;
      if (timeSinceUpdate <= RUNNING_THRESHOLD_MS) {
        status = 'running'; // Very recently updated - likely processing
      } else if (timeSinceUpdate <= ACTIVE_THRESHOLD_MS) {
        status = 'active'; // Recently used but not currently processing
      } else {
        status = 'idle'; // Not recently active
      }

      // Extract the actual model used.
      // WS RPC sessions have modelProvider + model directly on the session object.
      // Tool-invocation sessions have model on the last message.
      const lastMessage = session.messages?.[0] || null;
      let actualModel = null;
      if (session.modelProvider && session.model) {
        // WS RPC shape: modelProvider="openrouter", model="anthropic/claude-sonnet-4.5"
        // Normalize double prefixes (e.g., "openrouter/openrouter/..." -> "openrouter/...")
        let normalizedModel = session.model.trim();
        const doublePrefixMatch = normalizedModel.match(/^([^/]+)\/\1\/(.+)$/);
        if (doublePrefixMatch) {
          const [, prefix, rest] = doublePrefixMatch;
          normalizedModel = `${prefix}/${rest}`;
        }
        // Check if model already starts with the provider prefix to avoid duplication
        if (normalizedModel.startsWith(`${session.modelProvider.trim()}/`)) {
          actualModel = normalizedModel;
        } else {
          actualModel = `${session.modelProvider}/${normalizedModel}`;
        }
      } else if (lastMessage?.provider && lastMessage?.model) {
        // Normalize double prefixes
        let normalizedModel = lastMessage.model.trim();
        const doublePrefixMatch = normalizedModel.match(/^([^/]+)\/\1\/(.+)$/);
        if (doublePrefixMatch) {
          const [, prefix, rest] = doublePrefixMatch;
          normalizedModel = `${prefix}/${rest}`;
        }
        // Check if model already starts with the provider prefix
        if (normalizedModel.startsWith(`${lastMessage.provider.trim()}/`)) {
          actualModel = normalizedModel;
        } else {
          actualModel = `${lastMessage.provider}/${normalizedModel}`;
        }
      } else if (lastMessage?.model) {
        actualModel = lastMessage.model;
      } else if (session.model) {
        actualModel = session.model;
      }
      const model = actualModel || null;

      // Extract token usage.
      // Cron sessions: use the latest run's data (_cronLatestRun). When the gateway
      // collapses all isolated runs into one entry, _isCumulative is set so the
      // dashboard can label values as "Total" instead of "Last".
      // All other sessions: prefer enriched daily totals from sessions.usage (_usage* fields),
      // fall back to session-level fields, then last message usage.
      const usage = lastMessage?.usage || {};
      let inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, messageCost;
      if (session._cronLatestRun) {
        const r = session._cronLatestRun;
        inputTokens = r.input || 0;
        outputTokens = r.output || 0;
        cacheReadTokens = r.cacheRead || 0;
        cacheWriteTokens = r.cacheWrite || 0;
        messageCost =
          r.totalCost ||
          estimateCostFromTokens(model, inputTokens, outputTokens, {
            cacheReadTokens,
            cacheWriteTokens,
          }) ||
          0;
      } else {
        inputTokens = session._usageInput || session.inputTokens || usage.input || 0;
        outputTokens = session._usageOutput || session.outputTokens || usage.output || 0;
        cacheReadTokens = session._cacheRead || usage.cacheRead || 0;
        cacheWriteTokens = session._cacheWrite || usage.cacheWrite || 0;
        messageCost =
          session._totalCost ||
          usage.cost?.total ||
          estimateCostFromTokens(model, inputTokens, outputTokens, {
            cacheReadTokens,
            cacheWriteTokens,
          }) ||
          0;
      }

      // Context window usage.
      // session.totalTokens from sessions.list is the cumulative lifetime token count,
      // not the current context window fill — it can exceed contextTokens after compaction.
      // For cron sessions use the latest run's totalTokens (context fill at end of that isolated run).
      // For all sessions cap at contextTokens so the bar never exceeds 100%.
      const contextTokens = session.contextTokens || 0;
      const rawTotalTokens = session._cronLatestRun?.totalTokens ?? session.totalTokens ?? 0;
      const totalTokensUsed =
        contextTokens > 0 ? Math.min(rawTotalTokens, contextTokens) : rawTotalTokens;
      const contextUsagePercent =
        contextTokens > 0 ? Math.round((totalTokensUsed / contextTokens) * 100 * 10) / 10 : 0;

      // Extract last message text content (truncated)
      let lastMessageText = null;
      if (lastMessage?.content) {
        if (typeof lastMessage.content === 'string') {
          lastMessageText = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
          // Find the text block (skip thinking blocks)
          const textBlock = lastMessage.content.find((c) => c.type === 'text');
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
      // Check label/displayName/sessionLabel first (explicit labels), then key as fallback
      const displayName = (
        session.label ||
        session.name ||
        session.displayName ||
        session.sessionLabel ||
        ''
      )
        .toString()
        .toLowerCase();
      const sessionKey = (session.key || '').toString().toLowerCase();
      // Heartbeat sessions have explicit "heartbeat" in displayName/label, or key ends with ":heartbeat"
      const isHeartbeatSession =
        displayName.includes('heartbeat') ||
        sessionKey.endsWith(':heartbeat') ||
        sessionKey.includes(':heartbeat:');
      const hasUsage = inputTokens > 0 || outputTokens > 0;
      if (!lastMessageText && isHeartbeatSession && hasUsage) {
        lastMessageText = 'HEARTBEAT_OK';
      }

      // Derive semantic kind from session key when WS RPC returns generic "direct".
      // Session key format: "agent:<agentId>:<kind>[:<uuid>]" or "main"
      // WS RPC returns kind="direct" for all sessions; infer from key structure.
      let kind = session.kind || 'main';
      let sessionMode = null; // 'main' | 'isolated' — the session persistence mode
      if (kind === 'direct' && session.key) {
        const keyParts = session.key.split(':');
        if (keyParts[0] === 'agent' && keyParts.length >= 3) {
          const keyKind = keyParts[2]; // e.g. "main", "isolated", "cron", "subagent", "hook"
          if (keyKind) kind = keyKind;
        }
      }
      // Extract sessionMode from key third segment before remapping kind
      if (session.key) {
        const keyParts = session.key.split(':');
        if (keyParts[0] === 'agent' && keyParts.length >= 3) {
          const seg = keyParts[2];
          if (seg === 'main' || seg === 'isolated') sessionMode = seg;
        }
      }
      // v2026.2.19+: isolated sessions are heartbeat sessions (key: agent:<id>:isolated)
      if (kind === 'isolated') kind = 'heartbeat';

      // Check multiple possible label fields from OpenClaw (in priority order)
      // OpenClaw UI uses 'label' as the primary user-friendly label, so check it first
      // Then fall back to other fields if label is not available
      let rawLabel =
        session.label ||
        session.name ||
        session.displayName ||
        session.sessionLabel ||
        session.sessionId ||
        session.id;

      // Variables for Telegram session formatting (declared outside if block for debug logging)
      let telegramUserId = null;
      let telegramIdMatch = null;
      let userName = null;
      let topicName = null;
      let channelName = null;

      // Improve formatting for Telegram sessions
      // Check if displayName or rawLabel contains Telegram user ID format
      const isTelegramSession =
        rawLabel && typeof rawLabel === 'string' && rawLabel.toLowerCase().includes('telegram');

      // Extract cleaned group/user name for topic comparison
      // Remove "Telegram:" and "g-" prefixes for consistent comparison
      let cleanedGroupName = isTelegramSession
        ? rawLabel.replace(/(?:Telegram|telegram):\s*/gi, '').trim()
        : rawLabel;
      if (cleanedGroupName.startsWith('g-')) {
        cleanedGroupName = cleanedGroupName.substring(2);
      }

      if (isTelegramSession) {
        // Extract Telegram user ID - handle various formats and clean up double prefixes
        // First, extract the numeric ID directly from the string
        // Try to match "telegram:123" or "Telegram: 123" pattern first
        telegramIdMatch = rawLabel.match(/(?:telegram|Telegram):\s*(\d+)/i);
        telegramUserId = telegramIdMatch?.[1];

        // Check for user name in various fields (session fields and messages)
        // Note: For groups with topics, lastChannel might be the topic name, not the user name
        userName =
          session.lastTo ||
          session.userName ||
          session.user_name ||
          session.contactName ||
          lastMessage?.from?.name ||
          lastMessage?.from?.username ||
          lastMessage?.fromName ||
          lastMessage?.author ||
          lastMessage?.userName;

        // Filter out Telegram IDs - if userName looks like a Telegram ID (contains "telegram:" or matches the extracted ID), ignore it
        if (userName && typeof userName === 'string') {
          const userNameStr = userName.trim();
          if (
            userNameStr.toLowerCase().includes('telegram:') ||
            userNameStr === telegramUserId ||
            userNameStr.match(/^telegram:\d+$/i)
          ) {
            userName = null; // Don't use this as a user name
          } else {
            userName = userNameStr;
          }
        }

        // Remove "Telegram:" prefix from label since we'll show a telegram badge instead
        // Also remove "g-" prefix (Telegram group identifier) for cleaner display
        // Extract the actual name/ID without the prefixes
        let cleanedLabel = rawLabel.replace(/(?:Telegram|telegram):\s*/gi, '').trim();
        // Remove "g-" prefix if present (Telegram group convention)
        if (cleanedLabel.startsWith('g-')) {
          cleanedLabel = cleanedLabel.substring(2);
        }

        // Use user name if available and it's different from the ID and not just numbers
        if (
          userName &&
          typeof userName === 'string' &&
          userName.trim() &&
          userName !== telegramUserId &&
          !userName.match(/^\d+$/)
        ) {
          rawLabel = userName;
        } else if (telegramUserId) {
          // Use ONLY the extracted numeric ID (no "Telegram:" prefix)
          const userId = String(telegramUserId).trim();
          rawLabel = userId.length > 0 ? userId : cleanedLabel;
        } else {
          // Use cleaned label without prefixes
          rawLabel = cleanedLabel || rawLabel;
        }
      }

      // Extract topic/channel information for Telegram groups
      // Note: lastMessage is already declared earlier in this function
      // For Telegram groups with topics, check multiple possible locations

      // First, try to extract topic ID from session key
      // Format: agent:coo:telegram:group:-1003622044008:topic:584
      let topicIdFromKey = null;
      if (session.key && typeof session.key === 'string') {
        const keyParts = session.key.split(':');
        // Look for pattern: ...:telegram:group:*:topic:ID
        const telegramIdx = keyParts.indexOf('telegram');
        if (
          telegramIdx !== -1 &&
          keyParts[telegramIdx + 1] === 'group' &&
          keyParts.length > telegramIdx + 4 &&
          keyParts[telegramIdx + 3] === 'topic'
        ) {
          topicIdFromKey = keyParts[telegramIdx + 4];
          logger.debug('Extracted topic ID from session key', {
            sessionKey: session.key,
            topicId: topicIdFromKey,
            keyParts: keyParts,
          });
        }
      }

      const potentialTopicFromTo =
        lastMessage?.to &&
        typeof lastMessage.to === 'string' &&
        lastMessage.to.trim() !== cleanedGroupName &&
        !lastMessage.to.match(/^telegram:/i) &&
        !lastMessage.to.match(/^g-\d+$/) // Don't use group IDs as topic
          ? lastMessage.to.trim()
          : null;

      const potentialTopicFromChannel =
        session.lastChannel &&
        typeof session.lastChannel === 'string' &&
        session.lastChannel.trim() !== cleanedGroupName &&
        !session.lastChannel.match(/^telegram:/i) &&
        !session.lastChannel.match(/^telegram$/i) && // Ignore generic "telegram" value
        !session.lastChannel.match(/^g-\d+$/) &&
        session.lastChannel.trim() !== potentialTopicFromTo
          ? session.lastChannel.trim()
          : null;

      // Prefer topic name, fall back to topic ID from session key if name not available
      // Only use channel/to if they're meaningful (not generic values like "telegram")
      topicName =
        session.topic ||
        session.topicName ||
        session.topic_name ||
        lastMessage?.topic ||
        lastMessage?.topicName ||
        potentialTopicFromChannel ||
        potentialTopicFromTo ||
        (topicIdFromKey ? `Topic ${topicIdFromKey}` : null);
      channelName =
        session.lastChannel ||
        session.channel ||
        session.channelName ||
        session.channel_name ||
        lastMessage?.channel ||
        null;

      // Capitalize known single-word system labels (e.g. "heartbeat" → "Heartbeat")
      // Skip capitalization if we already formatted it above
      const label =
        typeof rawLabel === 'string' &&
        !rawLabel.includes(':') &&
        /^[a-z]/.test(rawLabel) &&
        !rawLabel.includes(' ')
          ? rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1)
          : rawLabel;

      const isCumulative = session._cronLatestRun?._isCumulative === true;
      const todayTotalCost = session._cronLatestRun?.totalCost ?? null;

      return {
        id: session.sessionId || session.id,
        key: session.key || null,
        label,
        status,
        kind,
        sessionMode,
        updatedAt: updatedAtMs || null,
        agent: agentName,
        model,
        // Token usage
        contextTokens,
        totalTokensUsed,
        contextUsagePercent,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        messageCost,
        todayTotalCost,
        isCumulative,
        // Last message
        lastMessage: lastMessageText,
        lastMessageRole: lastMessage?.role || null,
        // Topic/channel information (for Telegram groups with topics)
        topic: topicName || null,
        channel: channelName || null,
      };
    });

    // Sort by updatedAt descending (most recent first)
    transformedSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Enrich sessions with agent display names from users table
    const sessionAgentNameMap = new Map();
    try {
      const pool = require('../db/pool');
      const sessionAgentIds = [...new Set(transformedSessions.map((s) => s.agent).filter(Boolean))];
      if (sessionAgentIds.length > 0) {
        const result = await pool.query(
          'SELECT agent_id, name FROM users WHERE agent_id = ANY($1)',
          [sessionAgentIds],
        );
        result.rows.forEach((row) => {
          sessionAgentNameMap.set(row.agent_id, row.name);
        });
      }
    } catch (dbErr) {
      logger.warn('Could not query users table for session agent names', {
        error: dbErr.message,
      });
    }

    const enrichedSessions = transformedSessions.map((session) => ({
      ...session,
      agentName: sessionAgentNameMap.get(session.agent) || null,
    }));

    logger.info('Returning sessions', {
      userId: req.user.id,
      total: enrichedSessions.length,
      running: enrichedSessions.filter((s) => s.status === 'running').length,
      active: enrichedSessions.filter((s) => s.status === 'active').length,
      idle: enrichedSessions.filter((s) => s.status === 'idle').length,
    });

    res.json({
      data: enrichedSessions,
      dailyCost: sessions._dailyCost || 0,
    });
  } catch (error) {
    // If OpenClaw Gateway is not configured, return empty array
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw Gateway not available for sessions, returning empty array', {
        userId: req.user.id,
      });
      return res.json({ data: [] });
    }
    next(error);
  }
});

// DELETE /api/v1/openclaw/sessions
// Delete/terminate an OpenClaw session by session key (admin only)
// Query param: key (required) - the full session key (e.g. agent:cpo:cron:daily-standup)
// Calls OpenClaw Gateway sessions.delete RPC when supported.
router.delete('/sessions', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sessionKey = req.query.key;
    if (!sessionKey || typeof sessionKey !== 'string') {
      return res.status(400).json({
        error: {
          message: 'Query parameter key (session key) is required',
          status: 400,
        },
      });
    }

    logger.info('Deleting OpenClaw session', {
      userId: req.user.id,
      sessionKey,
    });

    const { gatewayWsRpc } = require('../services/openclawGatewayClient');

    try {
      await gatewayWsRpc('sessions.delete', { key: sessionKey });
      logger.info('Session deleted via Gateway sessions.delete', {
        sessionKey,
      });
      return res.status(204).send();
    } catch (rpcErr) {
      const msg = (rpcErr?.message || '').toLowerCase();
      if (msg.includes('method') || msg.includes('not found') || msg.includes('unknown')) {
        logger.warn('Gateway does not support sessions.delete RPC', {
          sessionKey,
          error: rpcErr.message,
        });
        return res.status(501).json({
          error: {
            message:
              'Session deletion is not supported by the OpenClaw Gateway. The sessions.delete RPC may not be available in this Gateway version.',
            status: 501,
            code: 'NOT_IMPLEMENTED',
          },
        });
      }
      if (msg.includes('webchat') || msg.includes('cannot delete')) {
        logger.warn('Gateway does not allow session deletion', {
          sessionKey,
          error: rpcErr.message,
        });
        return res.status(403).json({
          error: {
            message:
              'Session deletion is not allowed. The OpenClaw Gateway restricts session deletion for security reasons.',
            status: 403,
            code: 'FORBIDDEN',
          },
        });
      }
      throw rpcErr;
    }
  } catch (error) {
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      return res.status(503).json({
        error: {
          message: 'OpenClaw Gateway is not available',
          status: 503,
        },
      });
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
      includeTools,
    });

    // sessionKey is required since sessionsHistory needs it
    if (!sessionKey) {
      return res.status(400).json({
        error: 'Session key is required as a query parameter (key=...)',
      });
    }

    const {
      sessionsHistory,
      sessionsHistoryViaWs,
      sessionsListAllViaWs,
    } = require('../services/openclawGatewayClient');

    const parsedLimit = parseInt(limit, 10);
    let messages = [];
    let usedWsFallback = false;

    // For isolated cron run sessions the gateway sessions store has a stale `sessionFile`
    // pointer that is frozen at the first-ever run for the job. chat.history reads from
    // that stale file and always returns the wrong session's messages.
    // Fix: detect cron run keys (agent:<id>:cron:<jobId>:run:<sessionId>) and read the
    // per-run transcript JSONL directly from the workspace filesystem instead.
    const cronRunMatch = sessionKey?.match(/^agent:([^:]+):cron:[^:]+:run:([^:]+)$/);
    if (cronRunMatch) {
      const [, agentId, runSessionId] = cronRunMatch;
      const { getFileContent } = require('../services/openclawWorkspaceClient');
      const filePath = `/agents/${agentId}/sessions/${runSessionId}.jsonl`;
      try {
        const raw = await getFileContent(filePath);
        if (raw) {
          messages = raw
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter((e) => e && e.type === 'message' && e.message)
            .map((e) => ({
              ...e.message,
              timestamp: e.timestamp
                ? new Date(e.timestamp).getTime()
                : e.message.timestamp || null,
            }));
          logger.info('Cron run session history read from JSONL transcript', {
            sessionKey,
            filePath,
            messageCount: messages.length,
          });
        }
      } catch (jsonlErr) {
        logger.warn('Failed to read cron run JSONL transcript, falling back to chat.history', {
          sessionKey,
          filePath,
          error: jsonlErr.message,
        });
      }
    }

    // For non-cron-run sessions (or if JSONL read yielded nothing): use chat.history WebSocket RPC
    if (!cronRunMatch || messages.length === 0) {
      // Try WebSocket RPC first (chat.history) — bypasses tool visibility restrictions
      try {
        const wsResult = await sessionsHistoryViaWs({
          sessionKey,
          limit: parsedLimit || 200,
        });
        messages = Array.isArray(wsResult?.messages) ? wsResult.messages : [];
        logger.info('Session history fetched via WebSocket RPC', {
          sessionKey,
          messageCount: messages.length,
        });
      } catch (wsErr) {
        logger.warn('WebSocket chat.history failed, falling back to tool invocation', {
          sessionKey,
          error: wsErr.message,
        });
        usedWsFallback = true;
      }

      // Fallback: use sessions_history tool via /tools/invoke
      if (usedWsFallback) {
        const historyResult = await sessionsHistory({
          sessionKey,
          limit: parsedLimit,
          includeTools: includeTools === 'true' || includeTools === true,
        });

        logger.debug('sessionsHistory raw result', {
          sessionKey,
          resultType: Array.isArray(historyResult) ? 'array' : typeof historyResult,
          resultKeys:
            historyResult && typeof historyResult === 'object' ? Object.keys(historyResult) : null,
          isNull: historyResult === null,
          isUndefined: historyResult === undefined,
        });

        if (historyResult?.details?.status === 'forbidden') {
          logger.warn('Agent-to-agent history access forbidden', {
            sessionKey,
            error: historyResult.details.error,
          });

          return res.status(403).json({
            error: {
              message:
                'Agent session history is not accessible. Agent-to-agent access is disabled in OpenClaw Gateway.',
              code: 'AGENT_TO_AGENT_DISABLED',
              hint: 'Enable agent-to-agent access by setting tools.agentToAgent.enabled=true in OpenClaw Gateway configuration',
              details: historyResult.details,
            },
          });
        }

        if (Array.isArray(historyResult)) {
          messages = historyResult;
        } else if (historyResult && Array.isArray(historyResult.messages)) {
          messages = historyResult.messages;
        } else if (
          historyResult &&
          historyResult.details &&
          Array.isArray(historyResult.details.messages)
        ) {
          messages = historyResult.details.messages;
        } else if (historyResult && typeof historyResult === 'object') {
          logger.warn('Unexpected sessionsHistory result structure', {
            sessionKey,
            result: historyResult,
            resultKeys: Object.keys(historyResult),
          });
          messages = [];
        }
      }
    } // end: non-cron-run path

    logger.info('Session history loaded', {
      userId: req.user.id,
      sessionKey,
      messageCount: messages.length,
      source: usedWsFallback ? 'tool' : 'websocket',
      messageRoles: messages.map((m) => m.role),
      messageContentLengths: messages.map((m) => {
        if (typeof m.content === 'string') return m.content.length;
        if (Array.isArray(m.content)) {
          const textBlocks = m.content.filter((c) => c.type === 'text');
          return textBlocks.map((c) => c.text).join('').length;
        }
        return 0;
      }),
    });

    // Fetch session metadata via WebSocket sessions.list RPC (gateway-level, not agent-scoped).
    // This avoids the sessions_list tool invocation which fails when the agent session is
    // busy or locked (returns 500 tool_error from /tools/invoke).
    let session = null;
    try {
      const wsResult = await sessionsListAllViaWs({
        includeGlobal: true,
        includeUnknown: true,
      });
      // Handle both response formats: array or { sessions: [...] }
      const allSessions = Array.isArray(wsResult) ? wsResult : wsResult?.sessions || [];
      session = allSessions.find(
        (s) => s.sessionId === sessionId || s.id === sessionId || s.key === sessionKey,
      );
    } catch (metaErr) {
      logger.warn('sessionsListAllViaWs failed for session metadata, using minimal metadata', {
        sessionId,
        sessionKey,
        error: metaErr.message,
      });
    }

    // Transform messages for the dashboard
    // Messages are returned in chronological order (oldest first)
    const transformedMessages = messages.map((msg, index) => {
      // Extract text content, handling both string and array formats
      let content = null;
      let blocks = null;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Pass raw blocks through so the frontend can render toolCall chips,
        // thinking disclosures, etc. Also keep a flat text string for convenience.
        blocks = msg.content;
        const textBlocks = msg.content.filter((c) => c.type === 'text');
        content = textBlocks.map((c) => c.text).join('\n\n');
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
        blocks,
        model,
        provider: msg.provider || null,
        timestamp: msg.timestamp || null,
      };
    });

    // Build session metadata for context (fallback used when sessionsList fails)
    let agentNameFromKey = 'unknown';
    if (sessionKey && sessionKey.startsWith('agent:')) {
      const parts = sessionKey.split(':');
      if (parts.length >= 2) agentNameFromKey = parts[1];
    }
    let sessionMetadata = {
      id: sessionId,
      key: sessionKey,
      label: sessionId,
      agent: agentNameFromKey,
      status: 'unknown',
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
      const RUNNING_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
      const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
      const now = Date.now();
      const rawUpdatedAt = session.updatedAt ?? session.updated_at;
      const updatedAtMs = toUpdatedAtMs(rawUpdatedAt);
      const timeSinceUpdate = now - updatedAtMs;
      let status;
      if (timeSinceUpdate <= RUNNING_THRESHOLD_MS) {
        status = 'running';
      } else if (timeSinceUpdate <= ACTIVE_THRESHOLD_MS) {
        status = 'active';
      } else {
        status = 'idle';
      }

      const metaContextTokens = session.contextTokens || 0;
      const metaRawTotalTokens = session.totalTokens || 0;
      const metaTotalTokensUsed =
        metaContextTokens > 0
          ? Math.min(metaRawTotalTokens, metaContextTokens)
          : metaRawTotalTokens;
      const metaContextUsagePercent =
        metaContextTokens > 0
          ? Math.round((metaTotalTokensUsed / metaContextTokens) * 100 * 10) / 10
          : 0;

      sessionMetadata = {
        id: sessionId,
        key: session.key || sessionKey,
        label:
          session.label || session.name || session.displayName || session.sessionLabel || sessionId,
        agent: agentName,
        status,
        kind: session.kind || 'main',
        updatedAt: updatedAtMs || null,
        contextTokens: metaContextTokens,
        totalTokensUsed: metaTotalTokensUsed,
        contextUsagePercent: metaContextUsagePercent,
      };
    }

    logger.info('Returning session messages', {
      userId: req.user.id,
      sessionId,
      messageCount: transformedMessages.length,
    });

    // If there are no messages and the session wasn't found in sessions.list, the
    // agent's session simply isn't loaded in the gateway (e.g. agent hasn't been
    // active recently). Signal this to the dashboard so it can show a better message.
    const sessionNotLoaded = transformedMessages.length === 0 && !session;

    res.json({
      data: {
        messages: transformedMessages,
        session: sessionMetadata,
        sessionNotLoaded,
      },
    });
  } catch (error) {
    // If OpenClaw Gateway is not configured, return empty array
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw Gateway not available for session messages, returning empty', {
        userId: req.user.id,
        sessionId: req.params.sessionId,
      });
      return res.json({
        data: {
          messages: [],
          session: {
            id: req.params.sessionId,
            key: req.query.key || null,
            label: req.params.sessionId,
            agent: 'unknown',
            status: 'unknown',
          },
        },
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
      openclawConfig = parseOpenClawConfig(configData.content);
    } catch (configErr) {
      logger.warn('Could not read OpenClaw config for agent enrichment', {
        error: configErr.message,
      });
    }

    const [gatewayJobs, heartbeatJobs] = await Promise.all([
      // 1. Gateway scheduler jobs (orchestration, memory flush, etc.)
      cronList().catch((err) => {
        if (err.code === 'SERVICE_NOT_CONFIGURED' || err.code === 'SERVICE_UNAVAILABLE') {
          return [];
        }
        logger.warn('Failed to fetch gateway cron jobs', {
          error: err.message,
        });
        return [];
      }),

      // 2. Heartbeat configs from openclaw.json + runtime last-run data
      getHeartbeatJobsFromConfig(),
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
    const taggedGatewayJobs = gatewayJobs.map((job) => {
      const normalized = {
        ...job,
        source: job.source || 'gateway',
      };

      // Normalize schedule object if missing but raw cron/expression/interval exists
      if (!normalized.schedule) {
        if (job.cron) {
          normalized.schedule = {
            kind: 'cron',
            expr: job.cron,
            tz: job.tz || job.timezone || null,
          };
        } else if (job.expression) {
          normalized.schedule = {
            kind: 'cron',
            expr: job.expression,
            tz: job.tz || job.timezone || null,
          };
        } else if (job.interval || job.every) {
          const intervalStr = job.interval || job.every;
          const intervalMs = parseInterval(intervalStr);
          normalized.schedule = {
            kind: 'every',
            everyMs: intervalMs,
            label: intervalStr,
          };
        }
      }

      // Normalize lastRunAt — check state object (OpenClaw gateway format) first,
      // then common top-level field names
      if (!normalized.lastRunAt) {
        const state = job.state || {};
        if (state.lastRunAtMs) {
          normalized.lastRunAt = new Date(state.lastRunAtMs).toISOString();
        } else {
          normalized.lastRunAt =
            job.lastFiredAt || job.lastRanAt || job.lastRun || job.last_fired_at || null;
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
            options.tz = sched.tz || config.timezone;
            const interval = CronExpressionParser.parse(sched.expr, options);
            normalized.nextRunAt = interval.next().toISOString();
          } else if (sched.kind === 'every' && sched.everyMs && normalized.lastRunAt) {
            normalized.nextRunAt = new Date(
              new Date(normalized.lastRunAt).getTime() + sched.everyMs,
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
    const enrichedJobs = [...taggedGatewayJobs, ...heartbeatJobs].map((job) => {
      if (job.agentId && agentsList.length > 0) {
        const agent = agentsList.find((a) => a.id === job.agentId);
        if (agent && agent.model) {
          return {
            ...job,
            agentModel: agent.model?.primary || agent.model || null,
          };
        }
      }
      return job;
    });

    // Fetch session metadata (model, contextTokens) and detailed usage data
    // (tokens, cache, cost) via WebSocket RPC.
    // Cron session keys: parent = agent:{agentId}:cron:{jobId}
    //                    runs  = agent:{agentId}:cron:{jobId}:run:{runId}
    const { gatewayWsRpc } = require('../services/openclawGatewayClient');

    let cronSessionMap = new Map();
    // cronUsageByParent: parentKey -> { latest run usage, aggregate cost }
    let cronUsageByParent = new Map();
    try {
      const [sessionsResult, usageResult] = await Promise.all([
        gatewayWsRpc('sessions.list', { includeUnknown: true, limit: 500 }),
        gatewayWsRpc('sessions.usage', {
          startDate: new Date().toISOString().slice(0, 10),
          endDate: new Date().toISOString().slice(0, 10),
          limit: 2000,
        }).catch((err) => {
          logger.warn('Failed to fetch cron session usage', {
            error: err.message,
          });
          return { sessions: [] };
        }),
      ]);

      const allSessions = sessionsResult?.sessions || [];
      allSessions.forEach((s) => {
        if (
          s.key &&
          (s.key.includes(':cron:') ||
            s.key.includes(':heartbeat') ||
            // v2026.2.19+: isolated heartbeat sessions use agent:<id>:isolated
            /^agent:[^:]+:isolated$/.test(s.key))
        ) {
          cronSessionMap.set(s.key, s);
        }
      });

      // Group usage entries by parent cron key.
      // For isolated crons there are both per-run entries (:run: suffix) and a
      // parent entry that accumulates cumulative stats across all runs. If we
      // let the parent entry compete for latestRun its lastActivity always wins
      // (it is updated after every run) and we end up showing cumulative totals
      // instead of the latest run's stats. Bucket them separately and prefer
      // isolated run entries; fall back to the parent entry only for non-isolated
      // crons that have no :run: entries at all.
      //
      // Also covers heartbeat sessions:
      //   - Older format:   agent:<id>:heartbeat  (no :cron:)
      //   - v2026.2.19+:    agent:<id>:isolated   (no :cron:)
      //   - Isolated runs:  agent:<id>:isolated:run:<runId>
      const isCronOrHeartbeatKey = (key) =>
        key.includes(':cron:') ||
        key.includes(':heartbeat') ||
        /^agent:[^:]+:isolated(:|$)/.test(key);

      const cronRawBuckets = new Map(); // parentKey -> { runs: [], parent: null }
      for (const entry of usageResult?.sessions || []) {
        if (!entry.key || !isCronOrHeartbeatKey(entry.key)) continue;
        const runIdx = entry.key.indexOf(':run:');
        const isIsolatedRun = runIdx !== -1;
        const parentKey = isIsolatedRun ? entry.key.slice(0, runIdx) : entry.key;

        if (!cronRawBuckets.has(parentKey)) {
          cronRawBuckets.set(parentKey, { runs: [], parent: null });
        }
        const bucket = cronRawBuckets.get(parentKey);
        if (isIsolatedRun) {
          bucket.runs.push(entry.usage || {});
        } else {
          bucket.parent = entry.usage || {};
        }
      }

      for (const [parentKey, bucket] of cronRawBuckets) {
        // Prefer isolated run entries to avoid cumulative inflation from the
        // parent session. Fall back to the parent entry for non-isolated crons.
        const hasRuns = bucket.runs.length > 0;
        const entries = hasRuns ? bucket.runs : bucket.parent ? [bucket.parent] : [];
        const agg = {
          totalCost: 0,
          latestRun: null,
          latestActivity: 0,
          isCumulative: false,
        };
        for (const u of entries) {
          agg.totalCost += u.totalCost || 0;
          const activity = u.lastActivity || 0;
          if (activity > agg.latestActivity) {
            agg.latestActivity = activity;
            agg.latestRun = u;
          }
        }
        // Detect cumulative data in two scenarios:
        // 1. No :run: sub-keys — parent entry is the only source.
        // 2. Gateway collapsed all isolated runs into a single :run: entry
        //    whose messageCounts.user > 1 (each cron trigger = 1 user msg).
        if (!hasRuns && bucket.parent) {
          agg.isCumulative = true;
          agg.runCount = entries.length;
        } else if (hasRuns && bucket.runs.length === 1) {
          const userMsgs = bucket.runs[0]?.messageCounts?.user || 0;
          if (userMsgs > 1) {
            agg.isCumulative = true;
            agg.runCount = userMsgs;
          }
        }
        cronUsageByParent.set(parentKey, agg);
      }

      logger.info('Cron sessions fetched via WebSocket RPC', {
        totalSessions: allSessions.length,
        cronSessions: cronSessionMap.size,
        cronUsageEntries: cronUsageByParent.size,
      });
    } catch (wsErr) {
      logger.warn('Failed to fetch sessions via WebSocket for cron matching', {
        error: wsErr.message,
      });
    }

    // Merge execution data from cron sessions into each cron job.
    // Gateway cron session key: agent:{agentId}:cron:{jobId}
    // Heartbeat session key:    agent:{agentId}:heartbeat  (older)
    //                        OR agent:{agentId}:isolated   (v2026.2.19+ with session: isolated)
    const jobsWithExecutionData = enrichedJobs.map((job) => {
      if (!job.agentId) return job;

      const isHeartbeatJob = job.source === 'config' || job.payload?.kind === 'heartbeat';
      const jobId = job.jobId || job.id;

      // Gateway-only guard for non-heartbeat jobs
      if (!isHeartbeatJob && job.source !== 'gateway') return job;

      // Resolve the session target for this job.
      // systemEvent jobs with sessionTarget=main run inside the agent's main session;
      // agentTurn jobs always use isolated per-run sessions.
      const resolvedSessionTarget =
        job.sessionTarget ||
        job.payload?.session ||
        (job.payload?.kind === 'agentTurn' ? 'isolated' : 'main');

      let expectedKey;
      // messageSessionKey is the key where messages actually live (may differ from expectedKey
      // for main-session jobs where the cron key has no messages).
      let messageSessionKey;
      if (isHeartbeatJob) {
        // Try both heartbeat key variants; prefer isolated (v2026.2.19+) if present
        const isolatedKey = `agent:${job.agentId}:isolated`;
        const heartbeatKey = `agent:${job.agentId}:heartbeat`;
        expectedKey = cronSessionMap.has(isolatedKey) ? isolatedKey : heartbeatKey;
        messageSessionKey = expectedKey;
      } else {
        expectedKey = `agent:${job.agentId}:cron:${jobId}`;
        // systemEvent jobs targeting main run inside agent:{id}:main — messages live there
        messageSessionKey =
          resolvedSessionTarget === 'main' ? `agent:${job.agentId}:main` : expectedKey;
      }

      let matchedSession = cronSessionMap.get(expectedKey);
      // If no parent session exists, fall back to the most recently updated :run: sub-session
      // (isolated cron runs may only create per-run keys, not a persistent parent session).
      if (!matchedSession && !isHeartbeatJob) {
        const runPrefix = expectedKey + ':run:';
        let latestRunTs = 0;
        for (const [key, s] of cronSessionMap) {
          if (!key.startsWith(runPrefix)) continue;
          const ts = toUpdatedAtMs(s.updatedAt ?? s.updated_at) || 0;
          if (ts > latestRunTs) {
            latestRunTs = ts;
            matchedSession = s;
          }
        }
      }
      const usageAgg = cronUsageByParent.get(expectedKey);
      const latestRun = usageAgg?.latestRun;
      const jobLastRunMs = job.state?.lastRunAtMs;

      if (matchedSession || latestRun) {
        const isCumulative = usageAgg?.isCumulative === true;
        const actualModel = matchedSession?.model || null;

        const inputTokens = latestRun?.input ?? matchedSession?.inputTokens ?? 0;
        const outputTokens = latestRun?.output ?? matchedSession?.outputTokens ?? 0;
        const cacheReadTokens = latestRun?.cacheRead ?? 0;
        const cacheWriteTokens = latestRun?.cacheWrite ?? 0;
        const messageCost =
          latestRun?.totalCost ||
          estimateCostFromTokens(actualModel, inputTokens, outputTokens, {
            cacheReadTokens,
            cacheWriteTokens,
          }) ||
          0;

        const todayTotalCost = usageAgg?.totalCost ?? 0;
        const contextTokens = matchedSession?.contextTokens || 0;
        // latestRun.totalTokens is the context state at the end of that run; cap at contextTokens.
        const rawTotalTokens = latestRun?.totalTokens ?? matchedSession?.totalTokens ?? 0;
        const totalTokensUsed =
          contextTokens > 0 ? Math.min(rawTotalTokens, contextTokens) : rawTotalTokens;
        const contextUsagePercent =
          contextTokens > 0 ? Math.round((totalTokensUsed / contextTokens) * 100 * 10) / 10 : 0;

        return {
          ...job,
          lastExecution: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            messageCost,
            todayTotalCost,
            isCumulative,
            model: actualModel,
            lastMessage: null,
            updatedAt:
              toUpdatedAtMs(matchedSession?.updatedAt ?? matchedSession?.updated_at) ||
              jobLastRunMs ||
              null,
            contextTokens,
            totalTokensUsed,
            contextUsagePercent,
            sessionKey: messageSessionKey,
            sessionLabel: matchedSession?.displayName || matchedSession?.sessionLabel || null,
          },
        };
      }

      // No session or usage data — still provide the constructed key so the
      // detail panel can attempt to load messages via chat.history.
      return {
        ...job,
        lastExecution: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          messageCost: null,
          todayTotalCost: null,
          model: null,
          lastMessage: null,
          updatedAt: jobLastRunMs || null,
          contextTokens: null,
          totalTokensUsed: null,
          contextUsagePercent: null,
          sessionKey: messageSessionKey,
          durationMs: job.state?.lastDurationMs || null,
          status: job.state?.lastStatus || null,
          unavailable: true,
        },
      };
    });

    // Recalculate nextRunAt for heartbeat jobs based on actual lastExecution time
    // This fixes the issue where nextRunAt was calculated from stale file timestamps
    // instead of the actual execution time from the session
    const jobsWithRecalculatedNextRun = jobsWithExecutionData.map((job) => {
      const isHeartbeatJob = job.source === 'config' || job.payload?.kind === 'heartbeat';
      if (!isHeartbeatJob) return job;

      const lastExecutionTime = job.lastExecution?.updatedAt;
      const intervalMs = job.schedule?.everyMs;

      // If we have both actual execution time and interval, recalculate nextRunAt
      if (lastExecutionTime && intervalMs) {
        const lastExecutionMs =
          typeof lastExecutionTime === 'number'
            ? lastExecutionTime
            : new Date(lastExecutionTime).getTime();

        if (!isNaN(lastExecutionMs)) {
          const recalculatedNextRunAt = new Date(lastExecutionMs + intervalMs).toISOString();
          return {
            ...job,
            nextRunAt: recalculatedNextRunAt,
          };
        }
      }

      return job;
    });

    // Enrich jobs with agent display names from users table (agent_id -> name)
    // and agent titles from openclaw.json (identity.title)
    const agentNameMap = new Map();
    const agentTitleMap = new Map();

    // Build title map from openclaw.json
    (openclawConfig?.agents?.list || []).forEach((agent) => {
      if (agent.id) {
        agentTitleMap.set(agent.id, agent.identity?.title || null);
      }
    });

    // Query users table for display names
    try {
      const pool = require('../db/pool');
      const allAgentIds = [
        ...new Set(jobsWithRecalculatedNextRun.map((j) => j.agentId).filter(Boolean)),
      ];
      if (allAgentIds.length > 0) {
        const result = await pool.query(
          'SELECT agent_id, name FROM users WHERE agent_id = ANY($1)',
          [allAgentIds],
        );
        result.rows.forEach((row) => {
          agentNameMap.set(row.agent_id, row.name);
        });
      }
    } catch (dbErr) {
      logger.warn('Could not query users table for agent names', {
        error: dbErr.message,
      });
    }

    const finalJobs = jobsWithRecalculatedNextRun.map((job) => {
      if (!job.agentId) return job;
      return {
        ...job,
        agentName: agentNameMap.get(job.agentId) || null,
        agentTitle: agentTitleMap.get(job.agentId) || null,
      };
    });

    logger.info('Cron jobs aggregated', {
      userId: req.user.id,
      gateway: taggedGatewayJobs.length,
      heartbeats: heartbeatJobs.length,
      total: finalJobs.length,
      withExecutionData: finalJobs.filter((j) => j.lastExecution).length,
    });

    res.json({ data: { version: 1, jobs: finalJobs } });
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

/** Fetch heartbeat jobs from openclaw.json + runtime last-run data (for cron-jobs and cron-jobs/stats). */
async function getHeartbeatJobsFromConfig() {
  try {
    const data = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
    const config = parseOpenClawConfig(data.content);
    const agentsList = config?.agents?.list || [];
    const agentsWithHeartbeat = agentsList.filter((agent) => agent.heartbeat);

    const heartbeatResults = await Promise.all(
      agentsWithHeartbeat.map(async (agent) => {
        const hb = agent.heartbeat;
        const intervalMs = parseInterval(hb.every);

        let lastRunAt = null;
        let nextRunAt = null;
        try {
          const workspaceBase = agent.workspace || `/home/node/.openclaw/workspace-${agent.id}`;
          const relativePath = workspaceBase.replace(/^\/home\/node\/\.openclaw\//, '/');
          const hbData = await makeOpenClawRequest(
            'GET',
            `/files/content?path=${encodeURIComponent(`${relativePath}/runtime/heartbeat/last.json`)}`,
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
          // Heartbeat file may not exist yet
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
            activeHours: hb.activeHours || null,
          },
          delivery: {
            mode: hb.target === 'last' ? 'announce (last)' : hb.target || 'none',
          },
          lastRunAt,
          nextRunAt,
        };
      }),
    );

    return heartbeatResults;
  } catch (readError) {
    logger.warn('Could not read OpenClaw config for heartbeats', {
      error: readError.message,
    });
    return [];
  }
}

// GET /api/v1/openclaw/cron-jobs/stats
// Lightweight stats for attention badges (errors, missed) for any authenticated user
// NOTE: must be registered before /cron-jobs/:jobId to avoid being swallowed by the param route
router.get('/cron-jobs/stats', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching cron jobs stats for attention counts', {
      userId: req.user.id,
    });
    const { cronList } = require('../services/openclawGatewayClient');

    const gatewayJobsP = cronList().catch((err) => {
      logger.warn('Failed to fetch gateway jobs for stats', {
        error: err.message,
      });
      return [];
    });
    const configJobsP = getHeartbeatJobsFromConfig().catch((err) => {
      logger.warn('Failed to fetch config jobs for stats', {
        error: err.message,
      });
      return [];
    });

    let [gatewayJobs, configJobs] = await Promise.all([gatewayJobsP, configJobsP]);
    if (!Array.isArray(gatewayJobs)) gatewayJobs = [];
    if (!Array.isArray(configJobs)) configJobs = [];

    const gatewayJobsNormalized = gatewayJobs.map((job) => {
      let nextRunAtMs = job.state?.nextRunAtMs || null;
      if (!nextRunAtMs && job.enabled !== false) {
        if (job.cron || job.expression || (job.schedule?.kind === 'cron' && job.schedule?.expr)) {
          try {
            const expr = job.cron || job.expression || job.schedule.expr;
            const tz = job.tz || job.schedule?.tz || config.timezone;
            const { CronExpressionParser } = require('cron-parser');
            nextRunAtMs = CronExpressionParser.parse(expr, { tz }).next().getTime();
          } catch (_e) {
            nextRunAtMs = null;
          }
        }
      }
      return { ...job, nextRunAtMs };
    });

    const allJobs = [
      ...gatewayJobsNormalized,
      ...configJobs.map((j) => ({
        ...j,
        nextRunAtMs: j.state?.nextRunAtMs || null,
      })),
    ];
    const nowMs = Date.now();

    const errors = allJobs.filter(
      (j) => j.state?.lastStatus === 'error' || j.status === 'error',
    ).length;
    const missed = allJobs.filter(
      (j) => j.enabled !== false && j.nextRunAtMs && j.nextRunAtMs < nowMs,
    ).length;

    res.json({ data: { errors, missed } });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/cron-jobs/:jobId/runs
// Get run history for a single cron job, read from /cron/runs/{jobId}.jsonl in the workspace.
// This is the canonical persistent run log — more reliable than gateway sessions.list which
// only holds currently loaded (ephemeral) sessions.
// NOTE: must be registered before /cron-jobs/:jobId to avoid param route swallowing it.
router.get('/cron-jobs/:jobId/runs', requireAuth, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    // Basic UUID/slug validation to prevent path traversal
    if (!jobId || !/^[\w-]+$/.test(jobId)) {
      return res.status(400).json({ error: { message: 'Invalid jobId', status: 400 } });
    }

    logger.info('Fetching cron job run history from workspace', {
      userId: req.user.id,
      jobId,
      limit,
    });

    const { getFileContent } = require('../services/openclawWorkspaceClient');
    const { estimateCostFromTokens } = require('../services/modelPricingService');

    let runs = [];
    try {
      const content = await getFileContent(`/cron/runs/${jobId}.jsonl`);
      if (content) {
        runs = content
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter((r) => r && r.action === 'finished')
          // Sort newest-first to slice the most recent `limit` runs, then reverse to
          // return in chronological order (oldest first) so the UI can scroll to the
          // bottom to see the latest run.
          .sort((a, b) => (b.runAtMs || b.ts || 0) - (a.runAtMs || a.ts || 0))
          .slice(0, limit)
          .reverse()
          .map((r) => {
            const inputTokens = r.usage?.input_tokens ?? null;
            const outputTokens = r.usage?.output_tokens ?? null;
            // estimateCostFromTokens expects the bare model ID (e.g. "moonshotai/kimi-k2.5"),
            // which is exactly what OpenClaw stores in the run log (no "openrouter/" prefix).
            const estimatedCost = estimateCostFromTokens(r.model, inputTokens, outputTokens);
            return {
              sessionId: r.sessionId || null,
              sessionKey: r.sessionKey || null,
              runAtMs: r.runAtMs || r.ts || null,
              durationMs: r.durationMs || null,
              status: r.status || null,
              error: r.error || null,
              summary: r.summary || null,
              delivered: r.delivered ?? null,
              deliveryStatus: r.deliveryStatus || null,
              model: r.model || null,
              provider: r.provider || null,
              // total_tokens reflects context window size after the run (not input+output sum),
              // so we expose input/output separately and omit it to avoid confusion.
              inputTokens,
              outputTokens,
              estimatedCost: estimatedCost ?? null,
            };
          });
      }
    } catch (fileErr) {
      // File not found or workspace unavailable — return empty list gracefully
      logger.warn('Could not read cron runs JSONL from workspace', {
        jobId,
        error: fileErr.message,
      });
    }

    res.json({ runs, total: runs.length });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/cron-jobs/:jobId
// Get a single cron job by ID
router.get('/cron-jobs/:jobId', requireAuth, async (req, res, next) => {
  try {
    const { readCronJobs, fromOfficialFormat } = require('../services/cronJobsService');
    const { jobId } = req.params;

    logger.info('Fetching single cron job', { userId: req.user.id, jobId });

    const jobs = await readCronJobs();

    if (!jobs[jobId]) {
      return res.status(404).json({
        error: { message: `Cron job not found: ${jobId}`, status: 404 },
      });
    }

    res.json({ data: fromOfficialFormat(jobs[jobId]) });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/cron-jobs
// Create a new gateway cron job (admin only)
// jobId, id, createdAtMs, updatedAtMs, and state are system-managed and ignored if provided
router.post('/cron-jobs', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { createCronJob } = require('../services/cronJobsService');

    // Strip system-managed fields — jobId is always generated from the name
    // eslint-disable-next-line no-unused-vars
    const { jobId, id, createdAtMs, updatedAtMs, state, ...bodyWithoutSystemFields } = req.body;

    logger.info('Creating cron job', {
      userId: req.user.id,
      name: bodyWithoutSystemFields.name,
    });

    const job = await createCronJob(bodyWithoutSystemFields);

    recordActivityLogEventSafe({
      event_type: 'cron_job_created',
      source: 'cron',
      title: `Cron job created: ${job.name || job.jobId}`,
      description: `New cron job "${job.name}" created with schedule "${job.schedule}"`,
      severity: 'info',
      actor_user_id: req.user.id,
      job_id: job.jobId,
      meta: { name: job.name, schedule: job.schedule, agentId: job.agentId },
    });

    res.status(201).json({ data: job });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/openclaw/cron-jobs/:jobId
// Partially update an existing cron job (admin only)
// Supports both gateway jobs and heartbeat (config) jobs
// jobId and createdAtMs are immutable and will be ignored if provided in the body
router.patch('/cron-jobs/:jobId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { updateCronJob, updateHeartbeatJob } = require('../services/cronJobsService');
    const { jobId } = req.params;

    logger.info('Updating cron job', {
      userId: req.user.id,
      jobId,
      name: req.body.name,
    });

    // Check if this is a heartbeat job (jobId starts with 'heartbeat-')
    const isHeartbeat = jobId.startsWith('heartbeat-');

    let job;
    if (isHeartbeat) {
      job = await updateHeartbeatJob(jobId, req.body);
    } else {
      job = await updateCronJob(jobId, req.body);
    }

    recordActivityLogEventSafe({
      event_type: 'cron_job_updated',
      source: 'cron',
      title: `Cron job updated: ${jobId}`,
      description: `Cron job "${jobId}" configuration updated`,
      severity: 'info',
      actor_user_id: req.user.id,
      job_id: jobId,
      meta: { changes: req.body, isHeartbeat },
    });

    res.json({ data: job });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/cron-jobs/repair
// Repair a corrupted jobs.json by re-escaping bare newlines in string values (admin only)
router.post('/cron-jobs/repair', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { repairCronJobs } = require('../services/cronJobsService');

    logger.info('Attempting jobs.json repair', { userId: req.user.id });

    const result = await repairCronJobs();

    logger.info('jobs.json repair complete', {
      userId: req.user.id,
      recovered: result.recovered,
      lost: result.lost,
    });

    res.json({
      data: {
        recovered: result.recovered,
        lost: result.lost,
        message: `Repair complete. Recovered ${result.recovered} job(s).`,
      },
    });
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
        error: { message: 'enabled must be a boolean', status: 400 },
      });
    }

    // Heartbeat jobs cannot be enabled/disabled separately
    if (jobId.startsWith('heartbeat-')) {
      return res.status(400).json({
        error: {
          message:
            'Heartbeat jobs cannot be enabled/disabled via this endpoint. Edit the heartbeat configuration instead.',
          status: 400,
        },
      });
    }

    logger.info('Toggling cron job enabled state', {
      userId: req.user.id,
      jobId,
      enabled,
    });

    const job = await setCronJobEnabled(jobId, enabled);

    recordActivityLogEventSafe({
      event_type: 'cron_job_updated',
      source: 'cron',
      title: `Cron job ${enabled ? 'enabled' : 'disabled'}: ${jobId}`,
      description: `Cron job "${jobId}" was ${enabled ? 'enabled' : 'disabled'}`,
      severity: 'info',
      actor_user_id: req.user.id,
      job_id: jobId,
      meta: { enabled },
    });

    res.json({ data: job });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/cron-jobs/:jobId/run
// Manually trigger a cron job to run now (admin only)
router.post('/cron-jobs/:jobId/run', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { triggerCronJob } = require('../services/cronJobsService');
    const { jobId } = req.params;

    logger.info('Manual cron job run requested', {
      userId: req.user.id,
      jobId,
    });

    const job = await triggerCronJob(jobId);

    recordActivityLogEventSafe({
      event_type: 'cron_job_triggered',
      source: 'cron',
      title: `Cron job manually triggered: ${jobId}`,
      description: `Cron job "${jobId}" was manually triggered by user`,
      severity: 'info',
      actor_user_id: req.user.id,
      job_id: jobId,
      session_key: job.state?.lastSessionId || null,
      meta: { sessionId: job.state?.lastSessionId || null },
    });

    res.json({
      data: {
        success: true,
        sessionId: job.state?.lastSessionId || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/cron-jobs/:jobId/trigger
// Deprecated alias for /run — kept for backwards compatibility
router.post('/cron-jobs/:jobId/trigger', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { triggerCronJob } = require('../services/cronJobsService');
    const { jobId } = req.params;

    logger.info('Manual cron job trigger requested (deprecated /trigger endpoint)', {
      userId: req.user.id,
      jobId,
    });

    const job = await triggerCronJob(jobId);

    recordActivityLogEventSafe({
      event_type: 'cron_job_triggered',
      source: 'cron',
      title: `Cron job manually triggered: ${jobId}`,
      description: `Cron job "${jobId}" was manually triggered by user`,
      severity: 'info',
      actor_user_id: req.user.id,
      job_id: jobId,
      session_key: job.state?.lastSessionId || null,
      meta: { sessionId: job.state?.lastSessionId || null },
    });

    res.json({
      data: {
        success: true,
        sessionId: job.state?.lastSessionId || null,
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
          status: 400,
        },
      });
    }

    logger.info('Deleting cron job', {
      userId: req.user.id,
      jobId,
    });

    await deleteCronJob(jobId);

    recordActivityLogEventSafe({
      event_type: 'cron_job_deleted',
      source: 'cron',
      title: `Cron job deleted: ${jobId}`,
      description: `Cron job "${jobId}" was permanently deleted`,
      severity: 'warning',
      actor_user_id: req.user.id,
      job_id: jobId,
    });

    res.json({ data: { success: true } });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/usage
// Returns aggregated usage and cost data from session_usage_hourly.
// Query params:
//   range     — today | 24h | 3d | 7d | 14d | 30d | 3m | 6m  (default: 7d)
//              If startDate/endDate are provided, range is ignored
//   startDate — ISO 8601 date string (e.g., "2024-01-01T00:00:00Z") for custom range start
//   endDate   — ISO 8601 date string (e.g., "2024-01-31T23:59:59Z") for custom range end
//   groupBy   — hour | day  (default: hour for <=7d, day for longer ranges)
//   timezone  — IANA timezone (e.g., "America/New_York") for "today" calculation (optional, defaults to UTC)
//              When range="today", calculates the start of "today" in the specified timezone.
router.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const VALID_RANGES = ['today', '24h', '3d', '7d', '14d', '30d', '3m', '6m'];
    const range = VALID_RANGES.includes(req.query.range) ? req.query.range : '7d';
    const timezone = req.query.timezone || 'UTC';
    const startDateParam = req.query.startDate;
    const endDateParam = req.query.endDate;

    // Determine the start timestamp for the requested range
    const now = new Date();
    let startAt;
    let endAt = now; // Default end date is now

    // If custom date range is provided, use it instead of predefined range
    if (startDateParam && endDateParam) {
      startAt = new Date(startDateParam);
      endAt = new Date(endDateParam);

      // Validate dates
      if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
        return res.status(400).json({
          error: {
            message: 'Invalid date format. Use ISO 8601 format (e.g., "2024-01-01T00:00:00Z")',
            status: 400,
          },
        });
      }

      // Ensure start is before end
      if (startAt > endAt) {
        return res.status(400).json({
          error: { message: 'Start date must be before end date', status: 400 },
        });
      }
    } else {
      // Use predefined range logic
      switch (range) {
        case 'today': {
          // Calculate start of "today" in the user's timezone, then convert to UTC
          // Get today's date components in the target timezone
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          });
          const parts = formatter.formatToParts(now);
          const year = parts.find((p) => p.type === 'year').value;
          const month = parts.find((p) => p.type === 'month').value;
          const day = parts.find((p) => p.type === 'day').value;

          // Create a date at noon UTC on today's date (using noon avoids DST edge cases)
          const noonUTC = new Date(`${year}-${month}-${day}T12:00:00Z`);

          // Format noon UTC in the target timezone to see what time it is there
          const noonInTzFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
          const noonInTzParts = noonInTzFormatter.formatToParts(noonUTC);
          const noonHour = parseInt(noonInTzParts.find((p) => p.type === 'hour').value, 10);
          const noonMin = parseInt(noonInTzParts.find((p) => p.type === 'minute').value, 10);
          const noonSec = parseInt(noonInTzParts.find((p) => p.type === 'second').value, 10);

          // Calculate offset: if noon UTC is 14:00 in target TZ, offset is +2 hours
          // To get midnight in target TZ, we need to go back from noon UTC by (noonHour * 60 + noonMin) minutes
          const offsetMinutes = noonHour * 60 + noonMin + noonSec / 60;
          startAt = new Date(noonUTC.getTime() - offsetMinutes * 60 * 1000);
          break;
        }
        case '24h':
          startAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '3d':
          startAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
          break;
        case '7d':
          startAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '14d':
          startAt = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '3m':
          startAt = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        case '6m':
          startAt = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
          break;
        default:
          startAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
    }

    // Auto-select groupBy based on range unless explicitly provided
    // For custom ranges, calculate duration and use appropriate grouping
    let defaultGroupBy;
    if (startDateParam && endDateParam) {
      const durationDays = (endAt - startAt) / (24 * 60 * 60 * 1000);
      defaultGroupBy = durationDays <= 7 ? 'hour' : 'day';
    } else {
      const shortRanges = ['today', '24h', '3d', '7d'];
      defaultGroupBy = shortRanges.includes(range) ? 'hour' : 'day';
    }
    const groupBy =
      req.query.groupBy === 'day' ? 'day' : req.query.groupBy === 'hour' ? 'hour' : defaultGroupBy;

    logger.info('Fetching usage analytics', {
      userId: req.user.id,
      range: startDateParam && endDateParam ? 'custom' : range,
      startDate: startAt.toISOString(),
      endDate: endAt.toISOString(),
      groupBy,
    });

    // Summary totals
    const summaryResult = await pool.query(
      `SELECT
         COALESCE(SUM(cost_usd), 0)           AS total_cost_usd,
         COALESCE(SUM(tokens_input), 0)        AS total_tokens_input,
         COALESCE(SUM(tokens_output), 0)       AS total_tokens_output,
         COALESCE(SUM(tokens_cache_read), 0)   AS total_tokens_cache_read,
         COALESCE(SUM(tokens_cache_write), 0)  AS total_tokens_cache_write,
         COUNT(DISTINCT session_key)           AS session_count
       FROM session_usage_hourly
       WHERE hour_bucket >= $1 AND hour_bucket <= $2`,
      [startAt, endAt],
    );

    // Time-series bucketed by hour or day
    const timeSeriesResult = await pool.query(
      `SELECT
         date_trunc($1, hour_bucket)           AS bucket,
         COALESCE(SUM(cost_usd), 0)            AS cost_usd,
         COALESCE(SUM(tokens_input), 0)        AS tokens_input,
         COALESCE(SUM(tokens_output), 0)       AS tokens_output,
         COALESCE(SUM(tokens_cache_read), 0)   AS tokens_cache_read,
         COALESCE(SUM(tokens_cache_write), 0)  AS tokens_cache_write
       FROM session_usage_hourly
       WHERE hour_bucket >= $2 AND hour_bucket <= $3
       GROUP BY 1
       ORDER BY 1 ASC`,
      [groupBy, startAt, endAt],
    );

    // Breakdown by agent
    const byAgentResult = await pool.query(
      `SELECT
         agent_key,
         COALESCE(SUM(cost_usd), 0)            AS cost_usd,
         COALESCE(SUM(tokens_input), 0)        AS tokens_input,
         COALESCE(SUM(tokens_output), 0)       AS tokens_output,
         COALESCE(SUM(tokens_cache_read), 0)   AS tokens_cache_read,
         COALESCE(SUM(tokens_cache_write), 0)  AS tokens_cache_write,
         COUNT(DISTINCT session_key)           AS session_count
       FROM session_usage_hourly
       WHERE hour_bucket >= $1 AND hour_bucket <= $2
       GROUP BY agent_key
       ORDER BY cost_usd DESC`,
      [startAt, endAt],
    );

    // Breakdown by model
    // Normalize model names to group variants together while preserving provider prefixes
    // e.g., "openrouter/moonshotai/kimi-k2.5" and "moonshotai/kimi-k2.5" should be grouped as "openrouter/moonshotai/kimi-k2.5"
    // Also normalize double prefixes: "openrouter/openrouter/..." -> "openrouter/..."
    // This ensures platform differentiation (openrouter/ prefix) while consolidating duplicate entries
    // Use a CTE to identify models that should be normalized, then aggregate
    const byModelResult = await pool.query(
      `WITH normalized_models AS (
         SELECT 
           h.*,
           CASE 
             WHEN h.model IS NULL THEN NULL
             -- First, normalize double prefixes (e.g., "openrouter/openrouter/..." -> "openrouter/...")
             -- Pattern: matches "prefix/prefix/rest" and replaces with "prefix/rest"
             WHEN h.model ~ '^([^/]+)/\\1/' THEN 
               regexp_replace(h.model, '^([^/]+)/\\1/(.+)$', '\\1/\\2')
             -- If model already has openrouter/ prefix (after double prefix normalization), keep it
             WHEN h.model LIKE 'openrouter/%' THEN h.model
             -- If model doesn't have a provider prefix, check if there's a matching openrouter/ variant
             -- and normalize to openrouter/ version for grouping
             WHEN h.model NOT LIKE '%/%' AND EXISTS (
               SELECT 1 FROM session_usage_hourly h2 
               WHERE h2.hour_bucket >= $1 AND h2.hour_bucket <= $2
                 AND h2.model = 'openrouter/' || h.model
             ) THEN 'openrouter/' || h.model
             -- Otherwise keep as-is (may have other provider prefixes or be unqualified)
             ELSE h.model
           END AS normalized_model
         FROM session_usage_hourly h
         WHERE h.hour_bucket >= $1 AND h.hour_bucket <= $2
       )
       SELECT
         normalized_model AS model,
         COALESCE(SUM(cost_usd), 0)            AS cost_usd,
         COALESCE(SUM(tokens_input), 0)        AS tokens_input,
         COALESCE(SUM(tokens_output), 0)       AS tokens_output,
         COALESCE(SUM(tokens_cache_read), 0)   AS tokens_cache_read,
         COALESCE(SUM(tokens_cache_write), 0)  AS tokens_cache_write,
         COUNT(DISTINCT session_key)           AS session_count
       FROM normalized_models
       GROUP BY normalized_model
       ORDER BY cost_usd DESC`,
      [startAt, endAt],
    );

    // Breakdown by cron job (only rows where job_id is set)
    // job_label is derived from the first session_key seen for that job:
    //   "agent:<agentId>:cron:<jobId>:run:<sessionId>" -> label stored in session_usage
    // We use a subquery to pick a representative label from session_usage.
    const byJobResult = await pool.query(
      `SELECT
         h.job_id,
         (SELECT su.label
          FROM session_usage su
          WHERE su.job_id = h.job_id AND su.label IS NOT NULL
          LIMIT 1)                                AS job_label,
         MIN(h.agent_key)                         AS agent_key,
         COALESCE(SUM(h.cost_usd), 0)             AS cost_usd,
         COALESCE(SUM(h.tokens_input), 0)         AS tokens_input,
         COALESCE(SUM(h.tokens_output), 0)        AS tokens_output,
         COALESCE(SUM(h.tokens_cache_read), 0)    AS tokens_cache_read,
         COALESCE(SUM(h.tokens_cache_write), 0)   AS tokens_cache_write,
         COUNT(DISTINCT h.session_key)            AS run_count
       FROM session_usage_hourly h
       WHERE h.hour_bucket >= $1 AND h.hour_bucket <= $2
         AND h.job_id IS NOT NULL
       GROUP BY h.job_id
       ORDER BY cost_usd DESC`,
      [startAt, endAt],
    );

    const s = summaryResult.rows[0];

    res.json({
      data: {
        range,
        groupBy,
        summary: {
          totalCostUsd: parseFloat(s.total_cost_usd),
          totalTokensInput: parseInt(s.total_tokens_input, 10),
          totalTokensOutput: parseInt(s.total_tokens_output, 10),
          totalTokensCacheRead: parseInt(s.total_tokens_cache_read, 10),
          totalTokensCacheWrite: parseInt(s.total_tokens_cache_write, 10),
          sessionCount: parseInt(s.session_count, 10),
        },
        timeSeries: timeSeriesResult.rows.map((r) => ({
          bucket: r.bucket,
          costUsd: parseFloat(r.cost_usd),
          tokensInput: parseInt(r.tokens_input, 10),
          tokensOutput: parseInt(r.tokens_output, 10),
          tokensCacheRead: parseInt(r.tokens_cache_read, 10),
          tokensCacheWrite: parseInt(r.tokens_cache_write, 10),
        })),
        byAgent: byAgentResult.rows.map((r) => ({
          agentKey: r.agent_key,
          costUsd: parseFloat(r.cost_usd),
          tokensInput: parseInt(r.tokens_input, 10),
          tokensOutput: parseInt(r.tokens_output, 10),
          tokensCacheRead: parseInt(r.tokens_cache_read, 10),
          tokensCacheWrite: parseInt(r.tokens_cache_write, 10),
          sessionCount: parseInt(r.session_count, 10),
        })),
        byModel: byModelResult.rows.map((r) => ({
          model: r.model,
          costUsd: parseFloat(r.cost_usd),
          tokensInput: parseInt(r.tokens_input, 10),
          tokensOutput: parseInt(r.tokens_output, 10),
          tokensCacheRead: parseInt(r.tokens_cache_read, 10),
          tokensCacheWrite: parseInt(r.tokens_cache_write, 10),
          sessionCount: parseInt(r.session_count, 10),
        })),
        byJob: byJobResult.rows.map((r) => ({
          jobId: r.job_id,
          jobLabel: r.job_label || null,
          agentKey: r.agent_key,
          costUsd: parseFloat(r.cost_usd),
          tokensInput: parseInt(r.tokens_input, 10),
          tokensOutput: parseInt(r.tokens_output, 10),
          tokensCacheRead: parseInt(r.tokens_cache_read, 10),
          tokensCacheWrite: parseInt(r.tokens_cache_write, 10),
          runCount: parseInt(r.run_count, 10),
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/openclaw/usage/reset - Reset all usage data (admin only, requires password confirmation)
router.post('/usage/reset', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { password } = req.body;
    const userId = req.user.id;

    // Validate password is provided
    if (!password || password.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Password is required to confirm reset',
          status: 400,
        },
      });
    }

    // Verify user's password
    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: { message: 'User not found', status: 401 },
      });
    }

    const isValidPassword = await bcrypt.compare(password, userResult.rows[0].password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        error: { message: 'Invalid password', status: 401 },
      });
    }

    // Count records before deletion for response
    const hourlyCountResult = await pool.query(
      'SELECT COUNT(*) AS total FROM session_usage_hourly',
    );
    const usageCountResult = await pool.query('SELECT COUNT(*) AS total FROM session_usage');
    const deletedHourly = parseInt(hourlyCountResult.rows[0].total, 10);
    const deletedUsage = parseInt(usageCountResult.rows[0].total, 10);

    // Delete all usage data
    await pool.query('DELETE FROM session_usage_hourly');
    await pool.query('DELETE FROM session_usage');

    res.json({
      data: {
        success: true,
        deletedCount: {
          sessionUsage: deletedUsage,
          hourlyUsage: deletedHourly,
          total: deletedUsage + deletedHourly,
        },
        message: `All usage data has been permanently deleted (${deletedUsage} session usage records, ${deletedHourly} hourly records)`,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// OpenClaw Config Editor endpoints (admin/owner only)
// Uses Gateway WebSocket RPC (config.get / config.apply) for validated writes.
// Backups are stored as workspace files under /shared/backups/openclaw-config/.
// ============================================================================

const { gatewayWsRpc } = require('../services/openclawGatewayClient');

// Middleware: allow only admin or owner roles (explicitly block agent)
function requireOwnerOrAdmin(req, res, next) {
  if (!req.user || !['admin', 'owner'].includes(req.user.role)) {
    return res.status(403).json({
      error: {
        message: 'Admin or owner access required to manage OpenClaw configuration',
        status: 403,
        code: 'INSUFFICIENT_PERMISSIONS',
      },
    });
  }
  next();
}

// GET /api/v1/openclaw/config
// Read the live openclaw.json via Gateway RPC config.get (admin/owner only)
router.get('/config', requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    logger.info('Fetching OpenClaw config via Gateway RPC', {
      userId: req.user.id,
      userRole: req.user.role,
    });

    const result = await gatewayWsRpc('config.get', {});

    // config.get returns { raw, hash, ... }
    res.json({
      data: {
        raw: result.raw || result.config || '',
        hash: result.hash || null,
      },
    });
  } catch (error) {
    if (
      error.code === 'SERVICE_NOT_CONFIGURED' ||
      error.code === 'SERVICE_UNAVAILABLE' ||
      error.code === 'SERVICE_TIMEOUT'
    ) {
      return next(error);
    }
    logger.error('Failed to fetch OpenClaw config', {
      error: error.message,
      userId: req.user.id,
    });
    next(error);
  }
});

// PUT /api/v1/openclaw/config
// Validate + apply new config via Gateway RPC config.apply (admin/owner only).
// Writes a backup of the current config before applying.
// Body: { raw: string, baseHash: string, note?: string }
router.put('/config', requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const { raw, baseHash, note } = req.body;

    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
      return res.status(400).json({
        error: { message: 'raw config content is required', status: 400 },
      });
    }
    if (!baseHash || typeof baseHash !== 'string') {
      return res.status(400).json({
        error: {
          message: 'baseHash is required to prevent concurrent edit conflicts',
          status: 400,
        },
      });
    }

    logger.info('Applying OpenClaw config via Gateway RPC', {
      userId: req.user.id,
      userRole: req.user.role,
      note: note || null,
    });

    // Step 1: fetch current config to verify baseHash and capture snapshot for backup
    let currentConfig;
    try {
      currentConfig = await gatewayWsRpc('config.get', {});
    } catch (err) {
      logger.error('Failed to fetch current config before apply', {
        error: err.message,
      });
      return next(err);
    }

    const currentHash = currentConfig.hash || null;
    const currentRaw = currentConfig.raw || currentConfig.config || '';

    // Step 2: conflict check
    if (currentHash && baseHash !== currentHash) {
      logger.warn('OpenClaw config conflict detected', {
        userId: req.user.id,
        baseHash,
        currentHash,
      });
      return res.status(409).json({
        error: {
          message:
            'Config has been modified since you loaded it. Reload the latest version and re-apply your changes.',
          status: 409,
          code: 'CONFIG_CONFLICT',
        },
        data: {
          raw: currentRaw,
          hash: currentHash,
        },
      });
    }

    // Step 2b: restore __OPENCLAW_REDACTED__ placeholders from the current live config.
    // config.get masks sensitive values before returning them; if the user saves
    // without replacing a placeholder we substitute the original value back in so
    // the Gateway receives the real secret rather than the literal placeholder string.
    let rawToApply = raw;
    if (raw.includes('__OPENCLAW_REDACTED__') && currentRaw) {
      try {
        // Build a flat map of every string value in the current config keyed by
        // its JSON pointer path, then walk the submitted raw string and replace
        // each placeholder with the matching value from the current config.
        // We do a simple regex substitution on the raw strings rather than
        // parsing JSON5 (which Node has no built-in support for), matching
        // placeholder occurrences positionally by scanning both strings in parallel.
        //
        // Strategy: replace "__OPENCLAW_REDACTED__" occurrences one-by-one,
        // each time finding the Nth occurrence in currentRaw's string values.
        const PLACEHOLDER = '__OPENCLAW_REDACTED__';
        // Extract all string values from currentRaw in document order
        const valuePattern = /:\s*"((?:[^"\\]|\\.)*)"/g;
        const currentValues = [];
        let vm;
        while ((vm = valuePattern.exec(currentRaw)) !== null) {
          currentValues.push(vm[1]);
        }
        // Extract all string values from raw in document order
        const submittedValues = [];
        const submittedPattern = /:\s*"((?:[^"\\]|\\.)*)"/g;
        let sm;
        while ((sm = submittedPattern.exec(raw)) !== null) {
          submittedValues.push({
            value: sm[1],
            index: sm.index,
            fullMatch: sm[0],
          });
        }
        // For each submitted value that is the placeholder, replace with the
        // corresponding positional value from currentRaw
        let redactedCount = 0;
        for (let i = 0; i < submittedValues.length; i++) {
          if (submittedValues[i].value === PLACEHOLDER) {
            if (currentValues[i] !== undefined) {
              redactedCount++;
            }
          }
        }
        if (redactedCount > 0) {
          // Simpler and more reliable: do a global string replacement mapping
          // each placeholder back to the same-position value in currentRaw.
          // Since placeholders are identical strings we replace them one at a time
          // in order using indexOf to preserve positional mapping.
          let result = raw;
          let searchFrom = 0;
          for (let i = 0; i < submittedValues.length; i++) {
            if (submittedValues[i].value === PLACEHOLDER) {
              const originalValue = currentValues[i];
              if (originalValue !== undefined) {
                const pos = result.indexOf(`"${PLACEHOLDER}"`, searchFrom);
                if (pos !== -1) {
                  result =
                    result.slice(0, pos) +
                    `"${originalValue}"` +
                    result.slice(pos + PLACEHOLDER.length + 2);
                  searchFrom = pos + originalValue.length + 2;
                }
              }
            }
          }
          rawToApply = result;
          logger.info('Restored redacted placeholders in OpenClaw config before apply', {
            userId: req.user.id,
            restoredCount: redactedCount,
          });
        }
      } catch (restoreErr) {
        // Non-fatal: log and proceed with original raw; Gateway will reject if placeholder is invalid
        logger.warn('Failed to restore redacted placeholders (non-fatal)', {
          error: restoreErr.message,
          userId: req.user.id,
        });
      }
    }

    // Step 3: write backup of current config before applying new one
    const backupDir = '/shared/backups/openclaw-config';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${backupDir}/openclaw-${timestamp}.json5`;

    try {
      // Try to create the backup file (POST fails if exists, which is fine — timestamps are unique)
      await makeOpenClawRequest('POST', '/files', {
        path: backupPath,
        content: currentRaw,
        encoding: 'utf8',
      });
      logger.info('OpenClaw config backup created', {
        path: backupPath,
        userId: req.user.id,
      });
    } catch (backupErr) {
      // Backup failure is non-fatal: log a warning but continue with the apply
      logger.warn('Failed to write OpenClaw config backup (non-fatal)', {
        path: backupPath,
        error: backupErr.message,
        userId: req.user.id,
      });
    }

    // Step 4: apply via Gateway RPC config.apply (validates schema + restarts gateway)
    let applyResult;
    try {
      applyResult = await gatewayWsRpc('config.apply', {
        raw: rawToApply,
        baseHash: currentHash || baseHash,
        note: note || `Updated via MosBot Dashboard by user ${req.user.id}`,
        restartDelayMs: 2000,
      });
    } catch (applyErr) {
      // If the gateway is unreachable/timed out, surface a 503 rather than 400
      const isServiceError =
        applyErr.code === 'SERVICE_NOT_CONFIGURED' ||
        applyErr.code === 'SERVICE_UNAVAILABLE' ||
        applyErr.code === 'SERVICE_TIMEOUT' ||
        applyErr.code === 'DEVICE_AUTH_NOT_CONFIGURED' ||
        applyErr.status === 503;
      if (isServiceError) {
        logger.error('OpenClaw gateway unavailable during config.apply', {
          userId: req.user.id,
          error: applyErr.message,
          code: applyErr.code,
        });
        return next(applyErr);
      }
      // Surface validation errors from the gateway to the client
      logger.warn('OpenClaw config.apply rejected by gateway', {
        userId: req.user.id,
        error: applyErr.message,
        rpcCode: applyErr.rpcCode,
        rpcDetails: applyErr.rpcDetails,
      });
      return res.status(400).json({
        error: {
          message: applyErr.message || 'Config validation failed',
          status: 400,
          code: 'CONFIG_VALIDATION_FAILED',
          details: applyErr.rpcDetails || null,
        },
      });
    }

    // Step 5: record activity log
    recordActivityLogEventSafe({
      event_type: 'openclaw_config_updated',
      source: 'workspace',
      title: note ? `OpenClaw config updated: ${note}` : 'OpenClaw config updated',
      description: `User updated openclaw.json via Config Editor${note ? `. Note: ${note}` : ''}`,
      severity: 'warning',
      actor_user_id: req.user.id,
      workspace_path: '/openclaw.json',
      meta: {
        backupPath,
        baseHash,
        newHash: applyResult?.hash || null,
        note: note || null,
      },
    });

    res.json({
      data: {
        applied: true,
        hash: applyResult?.hash || null,
        backupPath,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/config/backups
// List backup files from /shared/backups/openclaw-config/ (admin/owner only)
router.get('/config/backups', requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    logger.info('Listing OpenClaw config backups', { userId: req.user.id });

    const backupDir = '/shared/backups/openclaw-config';
    let files = [];

    try {
      const data = await makeOpenClawRequest(
        'GET',
        `/files?path=${encodeURIComponent(backupDir)}&recursive=false`,
      );
      files = (data?.files || []).filter((f) => f.type === 'file');
    } catch (listErr) {
      // If directory doesn't exist yet (404) return empty list gracefully
      if (listErr.status === 404 || listErr.code === 'OPENCLAW_SERVICE_ERROR') {
        return res.json({ data: [] });
      }
      throw listErr;
    }

    // Sort newest first by name (ISO timestamp in filename)
    files.sort((a, b) => b.name.localeCompare(a.name));

    res.json({
      data: files.map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        modified: f.modified,
        created: f.created,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/openclaw/config/backups/content?path=...
// Read a specific backup file content (admin/owner only)
router.get('/config/backups/content', requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const { path: inputPath } = req.query;

    if (!inputPath) {
      return res.status(400).json({
        error: { message: 'path parameter is required', status: 400 },
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);

    // Restrict to backup directory only
    if (!workspacePath.startsWith('/shared/backups/openclaw-config/')) {
      return res.status(403).json({
        error: {
          message: 'Access restricted to OpenClaw config backup files only',
          status: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        },
      });
    }

    logger.info('Reading OpenClaw config backup', {
      path: workspacePath,
      userId: req.user.id,
    });

    const data = await makeOpenClawRequest(
      'GET',
      `/files/content?path=${encodeURIComponent(workspacePath)}`,
    );

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
