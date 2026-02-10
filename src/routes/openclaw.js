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

// Helper to parse JSONL files (one JSON object per line)
function parseJsonl(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }
  
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (_err) {
        // Ignore malformed lines
        return null;
      }
    })
    .filter(Boolean);
}

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

// GET /api/v1/openclaw/subagents
// Get running, queued, and completed subagents from OpenClaw workspace runtime files
router.get('/subagents', requireAuth, async (req, res, next) => {
  try {
    logger.info('Fetching subagent status', { userId: req.user.id });
    
    const { getFileContent } = require('../services/openclawWorkspaceClient');
    
    // Read all runtime files (fail gracefully if missing)
    // Rethrow SERVICE_NOT_CONFIGURED so we return 503 instead of empty data
    const wrapCatch = (p) => p.catch((err) => {
      if (err.code === 'SERVICE_NOT_CONFIGURED') throw err;
      return null;
    });
    const [spawnActiveContent, spawnRequestsContent, resultsCacheContent, activityLogContent] = await Promise.all([
      wrapCatch(getFileContent('/runtime/mosbot/spawn-active.jsonl')),
      wrapCatch(getFileContent('/runtime/mosbot/spawn-requests.json')),
      wrapCatch(getFileContent('/runtime/mosbot/results-cache.jsonl')),
      wrapCatch(getFileContent('/runtime/mosbot/activity-log.jsonl'))
    ]);
    
    // Parse running subagents from spawn-active.jsonl
    const running = parseJsonl(spawnActiveContent).map(entry => ({
      sessionKey: entry.sessionKey || null,
      sessionLabel: entry.sessionLabel || null,
      taskId: entry.taskId || null,
      status: 'RUNNING',
      model: entry.model || null,
      startedAt: entry.startedAt || null,
      timeoutMinutes: entry.timeoutMinutes || null
    }));
    
    // Parse queued subagents from spawn-requests.json
    let queued = [];
    if (spawnRequestsContent) {
      try {
        const spawnRequests = JSON.parse(spawnRequestsContent);
        queued = (spawnRequests.requests || [])
          .filter(r => r.status === 'SPAWN_QUEUED')
          .map(r => ({
            taskId: r.taskId || null,
            title: r.title || null,
            status: 'SPAWN_QUEUED',
            model: r.model || null,
            queuedAt: r.queuedAt || null
          }));
      } catch (err) {
        // Invalid JSON, leave queued empty
        logger.warn('Failed to parse spawn-requests.json', { error: err.message });
      }
    }
    
    // Parse activity log for timestamp enrichment
    const activityEntries = parseJsonl(activityLogContent);
    const activityBySession = new Map();
    
    activityEntries.forEach(entry => {
      const key = entry.sessionLabel || entry.taskId;
      if (key) {
        if (!activityBySession.has(key)) {
          activityBySession.set(key, []);
        }
        activityBySession.get(key).push(entry);
      }
    });
    
    // Parse completed subagents from results-cache.jsonl
    const resultsEntries = parseJsonl(resultsCacheContent);
    
    // Dedupe by sessionLabel, keeping latest cachedAt
    const completedMap = new Map();
    resultsEntries.forEach(entry => {
      const key = entry.sessionLabel;
      if (!key) return;
      
      const existing = completedMap.get(key);
      const entryCachedAt = entry.cachedAt || entry.timestamp || '';
      
      if (!existing || (entryCachedAt > (existing.cachedAt || existing.timestamp || ''))) {
        completedMap.set(key, entry);
      }
    });
    
    // Map completed entries with activity log enrichment
    const completed = Array.from(completedMap.values()).map(entry => {
      const sessionLabel = entry.sessionLabel;
      const taskId = entry.taskId || null;
      const completedAt = entry.cachedAt || entry.timestamp || null;
      
      // Try to find start time from activity log
      let startedAt = null;
      let durationSeconds = null;
      
      const activities = activityBySession.get(sessionLabel) || activityBySession.get(taskId) || [];
      const startEvent = activities.find(a => 
        a.event === 'agent_start' || 
        a.event === 'subagent_start' ||
        (a.timestamp && !a.event)
      );
      
      if (startEvent && startEvent.timestamp) {
        startedAt = startEvent.timestamp;
        
        // Calculate duration if we have both start and completion times
        if (completedAt && startedAt) {
          try {
            const start = new Date(startedAt).getTime();
            const end = new Date(completedAt).getTime();
            durationSeconds = Math.floor((end - start) / 1000);
      } catch (_err) {
        // Invalid date format, leave null
          }
        }
      }
      
      return {
        sessionLabel,
        taskId,
        status: 'COMPLETED',
        outcome: entry.outcome || null,
        startedAt,
        completedAt,
        durationSeconds
      };
    });
    
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
