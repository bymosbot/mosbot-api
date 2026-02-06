const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const path = require('path');
const { requireAdmin } = require('./auth');

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

// Helper to sleep for a given number of milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to check if an error is retryable
function isRetryableError(error) {
  // Retry on timeout errors
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }
  
  // Retry on connection errors
  if (error.message.includes('fetch failed') || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    return true;
  }
  
  // Retry on 503 Service Unavailable (transient server errors)
  if (error.status === 503 && error.code !== 'SERVICE_NOT_CONFIGURED') {
    return true;
  }
  
  return false;
}

// Helper to make requests to OpenClaw workspace service with retry logic
async function makeOpenClawRequest(method, path, body = null, retryCount = 0) {
  const maxRetries = 3;
  const baseDelayMs = 500; // Base delay of 500ms
  
  // Only use Kubernetes default if explicitly in production environment
  // In development, require explicit configuration to avoid connection errors
  const isProduction = process.env.NODE_ENV === 'production';
  const openclawUrl = process.env.OPENCLAW_WORKSPACE_URL || 
    (isProduction ? 'http://openclaw-workspace.agents.svc.cluster.local:8080' : null);
  const openclawToken = process.env.OPENCLAW_WORKSPACE_TOKEN;
  
  // Check if OpenClaw is configured (in local dev, URL should be explicitly set)
  if (!openclawUrl || openclawUrl === '') {
    const err = new Error('OpenClaw workspace service is not configured. Set OPENCLAW_WORKSPACE_URL to enable.');
    err.status = 503;
    err.code = 'SERVICE_NOT_CONFIGURED';
    throw err;
  }
  
  const url = `${openclawUrl}${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    // Add timeout to prevent hanging requests (10 seconds)
    signal: AbortSignal.timeout(10000),
  };
  
  // Add auth token if configured
  if (openclawToken) {
    options.headers['Authorization'] = `Bearer ${openclawToken}`;
  }
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`OpenClaw workspace service error: ${response.status} ${errorText}`);
      err.status = response.status;
      err.code = 'OPENCLAW_SERVICE_ERROR';
      
      // Retry on 503 if we haven't exceeded max retries
      if (isRetryableError(err) && retryCount < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, retryCount); // Exponential backoff
        logger.warn('OpenClaw workspace request failed, retrying', { 
          method, 
          path, 
          url,
          retryCount: retryCount + 1,
          maxRetries,
          delayMs,
          error: err.message
        });
        await sleep(delayMs);
        return makeOpenClawRequest(method, path, body, retryCount + 1);
      }
      
      throw err;
    }
    
    // Handle 204 No Content
    if (response.status === 204) {
      return null;
    }
    
    return await response.json();
  } catch (error) {
    // Handle connection/timeout errors with retry
    if (isRetryableError(error) && retryCount < maxRetries) {
      const delayMs = baseDelayMs * Math.pow(2, retryCount); // Exponential backoff
      logger.warn('OpenClaw workspace request failed, retrying', { 
        method, 
        path, 
        url,
        retryCount: retryCount + 1,
        maxRetries,
        delayMs,
        error: error.message,
        errorCode: error.code
      });
      await sleep(delayMs);
      return makeOpenClawRequest(method, path, body, retryCount + 1);
    }
    
    // Handle connection/timeout errors (after retries exhausted)
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      const err = new Error('OpenClaw workspace service request timed out');
      err.status = 503;
      err.code = 'SERVICE_TIMEOUT';
      logger.error('OpenClaw workspace request timed out after retries', { method, path, url, retryCount });
      throw err;
    }
    
    // Handle fetch failures (connection refused, DNS errors, etc.) (after retries exhausted)
    if (error.message.includes('fetch failed') || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      const err = new Error('OpenClaw workspace service is unavailable. This may be expected in local development.');
      err.status = 503;
      err.code = 'SERVICE_UNAVAILABLE';
      logger.warn('OpenClaw workspace service unavailable after retries', { 
        method, 
        path, 
        url,
        retryCount,
        hint: 'Set OPENCLAW_WORKSPACE_URL to disable or configure the service URL'
      });
      throw err;
    }
    
    // Re-throw if already has status code
    if (error.status) {
      logger.error('OpenClaw workspace request failed', { method, path, error: error.message, status: error.status, retryCount });
      throw error;
    }
    
    // Generic error
    const err = new Error(`OpenClaw workspace request failed: ${error.message}`);
    err.status = 503;
    err.code = 'SERVICE_ERROR';
    logger.error('OpenClaw workspace request failed', { method, path, error: error.message, retryCount });
    throw err;
  }
}

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
// Create or update file (admin/owner only)
router.post('/workspace/files', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { path: inputPath, content, encoding = 'utf8' } = req.body;
    
    if (!inputPath || content === undefined) {
      return res.status(400).json({ 
        error: { message: 'Path and content are required', status: 400 } 
      });
    }

    const workspacePath = normalizeAndValidateWorkspacePath(inputPath);
    
    logger.info('Writing OpenClaw workspace file', { 
      userId: req.user.id, 
      path: workspacePath,
      contentLength: content.length 
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

module.exports = router;
