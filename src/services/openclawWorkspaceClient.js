const config = require('../config');
const logger = require('../utils/logger');

// Helper to sleep for a given number of milliseconds
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper to check if an error is retryable
function isRetryableError(error) {
  // Retry on timeout errors
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }

  // Retry on connection errors
  if (
    error.message.includes('fetch failed') ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ENOTFOUND'
  ) {
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
  const openclawUrl =
    config.openclaw.workspaceUrl ||
    (config.nodeEnv === 'production'
      ? 'http://openclaw-workspace.agents.svc.cluster.local:8080'
      : null);
  const openclawToken = config.openclaw.workspaceToken;

  // Check if OpenClaw is configured (in local dev, URL should be explicitly set)
  if (!openclawUrl || openclawUrl === '') {
    const err = new Error(
      'OpenClaw workspace service is not configured. Set OPENCLAW_WORKSPACE_URL to enable.',
    );
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
          error: err.message,
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
        errorCode: error.code,
      });
      await sleep(delayMs);
      return makeOpenClawRequest(method, path, body, retryCount + 1);
    }

    // Handle connection/timeout errors (after retries exhausted)
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      const err = new Error('OpenClaw workspace service request timed out');
      err.status = 503;
      err.code = 'SERVICE_TIMEOUT';
      logger.error('OpenClaw workspace request timed out after retries', {
        method,
        path,
        url,
        retryCount,
      });
      throw err;
    }

    // Handle fetch failures (connection refused, DNS errors, etc.) (after retries exhausted)
    if (
      error.message.includes('fetch failed') ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND'
    ) {
      const err = new Error(
        'OpenClaw workspace service is unavailable. This may be expected in local development.',
      );
      err.status = 503;
      err.code = 'SERVICE_UNAVAILABLE';
      logger.warn('OpenClaw workspace service unavailable after retries', {
        method,
        path,
        url,
        retryCount,
        hint: 'Set OPENCLAW_WORKSPACE_URL to disable or configure the service URL',
      });
      throw err;
    }

    // Re-throw if already has status code
    if (error.status) {
      // 404 is expected for optional/missing files (e.g. runtime subagent files); avoid ERROR noise
      if (error.status === 404) {
        logger.debug('OpenClaw workspace file not found', {
          method,
          path,
          status: 404,
        });
      } else {
        logger.error('OpenClaw workspace request failed', {
          method,
          path,
          error: error.message,
          status: error.status,
          retryCount,
        });
      }
      throw error;
    }

    // Generic error
    const err = new Error(`OpenClaw workspace request failed: ${error.message}`);
    err.status = 503;
    err.code = 'SERVICE_ERROR';
    logger.error('OpenClaw workspace request failed', {
      method,
      path,
      error: error.message,
      retryCount,
    });
    throw err;
  }
}

/**
 * Get file content from OpenClaw workspace
 * @param {string} path - Workspace file path (e.g., '/runtime/mosbot/spawn-active.jsonl')
 * @returns {Promise<string|null>} File content as string, or null if file not found (404)
 * @throws {Error} For non-404 errors (service unavailable, network errors, etc.)
 */
async function getFileContent(path) {
  try {
    const data = await makeOpenClawRequest(
      'GET',
      `/files/content?path=${encodeURIComponent(path)}`,
    );
    return data?.content || null;
  } catch (error) {
    // Return null for 404 (file not found), throw for other errors
    if (error.status === 404 || error.code === 'OPENCLAW_SERVICE_ERROR') {
      return null;
    }
    throw error;
  }
}

/**
 * Write file content to OpenClaw workspace
 * @param {string} path - Workspace file path
 * @param {string} content - File content
 * @param {string} encoding - File encoding (default 'utf8')
 * @returns {Promise<Object>} Response data
 */
async function putFileContent(path, content, encoding = 'utf8') {
  return makeOpenClawRequest('PUT', '/files', {
    path,
    content,
    encoding,
  });
}

module.exports = {
  makeOpenClawRequest,
  getFileContent,
  putFileContent,
  sleep,
  isRetryableError,
};
