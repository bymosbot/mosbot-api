const logger = require('../utils/logger');

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

// Helper to make requests to OpenClaw Gateway with retry logic
async function makeOpenClawGatewayRequest(path, body = null, retryCount = 0) {
  const maxRetries = 3;
  const baseDelayMs = 500; // Base delay of 500ms
  
  // Only use Kubernetes default if explicitly in production environment
  // In development, require explicit configuration to avoid connection errors
  const isProduction = process.env.NODE_ENV === 'production';
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 
    (isProduction ? 'http://openclaw.agents.svc.cluster.local:18789' : null);
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  
  // Check if OpenClaw Gateway is configured (in local dev, URL should be explicitly set)
  if (!gatewayUrl || gatewayUrl === '') {
    const err = new Error('OpenClaw gateway is not configured. Set OPENCLAW_GATEWAY_URL to enable.');
    err.status = 503;
    err.code = 'SERVICE_NOT_CONFIGURED';
    throw err;
  }
  
  const url = `${gatewayUrl}${path}`;
  const timeoutMs = parseInt(process.env.OPENCLAW_GATEWAY_TIMEOUT_MS || '15000', 10);
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  
  // Add auth token if configured
  if (gatewayToken) {
    options.headers['Authorization'] = `Bearer ${gatewayToken}`;
  }
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`OpenClaw gateway error: ${response.status} ${errorText}`);
      err.status = response.status;
      err.code = 'OPENCLAW_GATEWAY_ERROR';
      
      // Retry on 503 if we haven't exceeded max retries
      if (isRetryableError(err) && retryCount < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, retryCount); // Exponential backoff
        logger.warn('OpenClaw gateway request failed, retrying', { 
          path, 
          url,
          retryCount: retryCount + 1,
          maxRetries,
          delayMs,
          error: err.message
        });
        await sleep(delayMs);
        return makeOpenClawGatewayRequest(path, body, retryCount + 1);
      }
      
      throw err;
    }
    
    return await response.json();
  } catch (error) {
    // Handle connection/timeout errors with retry
    if (isRetryableError(error) && retryCount < maxRetries) {
      const delayMs = baseDelayMs * Math.pow(2, retryCount); // Exponential backoff
      logger.warn('OpenClaw gateway request failed, retrying', { 
        path, 
        url,
        retryCount: retryCount + 1,
        maxRetries,
        delayMs,
        error: error.message,
        errorCode: error.code
      });
      await sleep(delayMs);
      return makeOpenClawGatewayRequest(path, body, retryCount + 1);
    }
    
    // Handle connection/timeout errors (after retries exhausted)
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      const err = new Error('OpenClaw gateway request timed out');
      err.status = 503;
      err.code = 'SERVICE_TIMEOUT';
      logger.error('OpenClaw gateway request timed out after retries', { path, url, retryCount });
      throw err;
    }
    
    // Handle fetch failures (connection refused, DNS errors, etc.) (after retries exhausted)
    if (error.message.includes('fetch failed') || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      const err = new Error('OpenClaw gateway is unavailable. This may be expected in local development.');
      err.status = 503;
      err.code = 'SERVICE_UNAVAILABLE';
      logger.warn('OpenClaw gateway unavailable after retries', { 
        path, 
        url,
        retryCount,
        hint: 'Set OPENCLAW_GATEWAY_URL to disable or configure the gateway URL'
      });
      throw err;
    }
    
    // Re-throw if already has status code
    if (error.status) {
      // 401 is handled by callers (e.g. invokeTool) — log at debug to avoid double-logging
      const logLevel = error.status === 401 ? 'debug' : 'error';
      logger[logLevel]('OpenClaw gateway request failed', { path, error: error.message, status: error.status, retryCount });
      throw error;
    }
    
    // Generic error
    const err = new Error(`OpenClaw gateway request failed: ${error.message}`);
    err.status = 503;
    err.code = 'SERVICE_ERROR';
    logger.error('OpenClaw gateway request failed', { path, error: error.message, retryCount });
    throw err;
  }
}

/**
 * Invoke a tool via OpenClaw Gateway /tools/invoke endpoint
 * @param {string} tool - Tool name (e.g., 'sessions_list', 'sessions_history')
 * @param {object} args - Tool-specific arguments
 * @param {object} options - Additional options (sessionKey, action, dryRun)
 * @returns {Promise<object>} Tool result
 */
async function invokeTool(tool, args = {}, options = {}) {
  const { sessionKey = 'main', action = 'json', dryRun = false } = options;
  
  const body = {
    tool,
    action,
    args,
    sessionKey,
    dryRun
  };
  
  try {
    const response = await makeOpenClawGatewayRequest('/tools/invoke', body);
    
    if (!response.ok) {
      const err = new Error(response.error?.message || 'Tool invocation failed');
      err.status = 400;
      err.code = 'TOOL_INVOCATION_ERROR';
      throw err;
    }
    
    return response.result || response;
  } catch (error) {
    // Return null for 404 (tool not available) — the tool genuinely doesn't exist
    if (error.status === 404) {
      logger.warn('Tool not available', { tool, error: error.message });
      return null;
    }
    // Surface auth errors clearly instead of masking them as "tool not available"
    if (error.status === 401) {
      logger.warn('OpenClaw gateway auth failed for tool invocation', {
        tool,
        sessionKey,
        status: error.status
      });
      return null;
    }
    throw error;
  }
}

/**
 * List sessions via sessions_list tool
 * @param {object} params - Query parameters
 * @param {string} params.sessionKey - Full session key for agent context (e.g., 'main', 'agent:coo:main')
 * @param {string[]} params.kinds - Filter by session kinds (main, group, cron, hook, node, other)
 * @param {number} params.limit - Max rows to return
 * @param {number} params.activeMinutes - Only sessions updated within N minutes
 * @param {number} params.messageLimit - Include last N messages per session (0 = no messages)
 * @returns {Promise<Array>} Array of session rows
 */
async function sessionsList({ sessionKey = 'main', kinds, limit, activeMinutes, messageLimit } = {}) {
  const args = {};
  
  if (kinds) args.kinds = kinds;
  if (limit != null) args.limit = limit;
  if (activeMinutes != null) args.activeMinutes = activeMinutes;
  if (messageLimit != null) args.messageLimit = messageLimit;
  
  try {
    const result = await invokeTool('sessions_list', args, { sessionKey });
    // sessions_list returns various structures depending on the tool implementation
    if (!result) {
      return [];
    }
    
    // Handle direct array response
    if (Array.isArray(result)) {
      return result;
    }
    
    // Handle { details: { sessions: [...] } } structure (OpenClaw Gateway format)
    if (result.details && Array.isArray(result.details.sessions)) {
      return result.details.sessions;
    }
    
    // Handle { rows: [...] } structure
    if (result.rows && Array.isArray(result.rows)) {
      return result.rows;
    }
    
    // Handle { sessions: [...] } structure
    if (result.sessions && Array.isArray(result.sessions)) {
      return result.sessions;
    }
    
    // Fallback to empty array if structure is unexpected
    logger.warn('Unexpected sessions_list result structure', { result });
    return [];
  } catch (error) {
    // If service is not configured, return empty array (graceful degradation)
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw gateway not available for sessions_list, returning empty array');
      return [];
    }
    throw error;
  }
}

/**
 * Fetch session history via sessions_history tool
 * @param {object} params - Query parameters
 * @param {string} params.sessionKey - Session key or sessionId
 * @param {number} params.limit - Max messages to return
 * @param {boolean} params.includeTools - Include tool result messages
 * @returns {Promise<Array>} Array of messages
 */
async function sessionsHistory({ sessionKey, limit, includeTools } = {}) {
  if (!sessionKey) {
    throw new Error('sessionKey is required for sessions_history');
  }
  
  const args = { sessionKey };
  if (limit != null) args.limit = limit;
  if (includeTools != null) args.includeTools = includeTools;
  
  try {
    // Pass sessionKey as the invocation context so the Gateway sees the request
    // as coming from the target agent's own session (avoids cross-agent access check)
    const result = await invokeTool('sessions_history', args, { sessionKey });
    
    // Log detailed information about the result for debugging
    logger.info('sessions_history tool result', {
      sessionKey,
      resultType: Array.isArray(result) ? 'array' : typeof result,
      resultKeys: result && typeof result === 'object' ? Object.keys(result) : null,
      messagesCount: result?.messages?.length || (Array.isArray(result) ? result.length : 0),
      hasMessages: !!(result?.messages || Array.isArray(result)),
      isNull: result === null,
      isUndefined: result === undefined
    });
    
    // sessions_history returns { messages: [...] } or just an array
    const messages = result?.messages || result || [];
    
    // Warn if we got an empty result for a session that should have data
    if ((!messages || messages.length === 0) && sessionKey) {
      logger.warn('sessions_history returned empty messages', {
        sessionKey,
        args,
        resultType: typeof result,
        result: result ? JSON.stringify(result).substring(0, 200) : null
      });
    }
    
    return messages;
  } catch (error) {
    // If service is not configured, return empty array (graceful degradation)
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw gateway not available for sessions_history, returning empty array', {
        sessionKey
      });
      return [];
    }
    throw error;
  }
}

/**
 * List cron jobs from the OpenClaw Gateway scheduler.
 * Tries the cron.list tool first (via /tools/invoke), then falls back to
 * reading the persisted jobs.json from the workspace service.
 * @returns {Promise<Array>} Array of cron job objects
 */
async function cronList() {
  // Attempt 1: Try cron.list via /tools/invoke
  try {
    const result = await invokeTool('cron.list', {});
    if (result) {
      const jobs = extractJobsArray(result);
      if (jobs.length > 0) {
        logger.info('cron.list returned jobs via /tools/invoke', { count: jobs.length });
        return jobs;
      }
    }
  } catch (error) {
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw gateway not available for cron.list, returning empty array');
      return [];
    }
    // Log and fall through to fallback
    logger.warn('cron.list tool invocation failed, trying jobs.json fallback', {
      error: error.message,
      code: error.code,
    });
  }

  // Attempt 2: Read the persisted jobs.json from the workspace service
  // OpenClaw stores cron jobs at ~/.openclaw/cron/jobs.json on the gateway host.
  // In containerized setups this is typically at /home/node/.openclaw/cron/jobs.json
  // which may be accessible via the workspace service.
  try {
    const { getFileContent } = require('./openclawWorkspaceClient');
    const content = await getFileContent('/cron/jobs.json');
    if (content) {
      const raw = typeof content === 'string' ? content : content.content || content;
      const parsed = parseJsonWithLiteralNewlines(raw);
      const jobs = extractJobsArray(parsed);
      if (jobs.length > 0) {
        logger.info('cron jobs loaded from jobs.json fallback', { count: jobs.length });
        return jobs;
      }
    }
  } catch (fallbackError) {
    logger.warn('jobs.json fallback also failed', {
      error: fallbackError.message,
    });
  }

  return [];
}

/**
 * Parse JSON that may contain literal (unescaped) newline characters and/or
 * unescaped double-quote characters inside string values — a common artifact
 * when OpenClaw writes multiline payloads (e.g. markdown code blocks) to jobs.json.
 *
 * Strategy:
 *  1. Try a direct JSON.parse (fast path).
 *  2. Find markdown code blocks that are delimited by *literal* newlines
 *     (i.e. the code block was written raw into a JSON string without escaping).
 *     Escape their content: literal \n → \\n, unescaped " → \".
 *  3. Escape any remaining bare \n/\r that sit inside JSON string values
 *     using a character-by-character walk.
 *  4. Final JSON.parse attempt.
 */
function parseJsonWithLiteralNewlines(str) {
  // Fast path
  try { return JSON.parse(str); } catch (_) { /* fall through */ }

  // Pass 1: fix markdown code blocks that contain literal newlines + unescaped quotes.
  // These appear when OpenClaw writes a payload message that includes a ```json ... ```
  // example block without escaping the content for JSON string embedding.
  // Pattern: literal-newline + ```[lang] + literal-newline + content + literal-newline + ``` + literal-newline
  let fixed = str.replace(/\n(```[a-z]*)\n([\s\S]*?)\n(```)\n/g, (_match, open, codeContent, close) => {
    const escapedContent = codeContent
      .replace(/\\/g, '\\\\')   // escape existing backslashes first
      .replace(/"/g, '\\"')     // escape unescaped double quotes
      .replace(/\n/g, '\\n')    // escape remaining literal newlines
      .replace(/\r/g, '\\r');
    return '\\n' + open + '\\n' + escapedContent + '\\n' + close + '\\n';
  });

  try { return JSON.parse(fixed); } catch (_) { /* fall through */ }

  // Pass 2: escape any remaining bare \n/\r inside JSON string values.
  let sanitized = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < fixed.length; i++) {
    const ch = fixed[i];
    if (escaped) {
      sanitized += ch;
      escaped = false;
    } else if (ch === '\\' && inString) {
      sanitized += ch;
      escaped = true;
    } else if (ch === '"') {
      sanitized += ch;
      inString = !inString;
    } else if (inString && ch === '\n') {
      sanitized += '\\n';
    } else if (inString && ch === '\r') {
      sanitized += '\\r';
    } else {
      sanitized += ch;
    }
  }

  return JSON.parse(sanitized); // throws if still broken
}

/**
 * Extract a flat array of jobs from various response shapes
 */
function extractJobsArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.jobs && Array.isArray(data.jobs)) return data.jobs;
  if (data.details && Array.isArray(data.details.jobs)) return data.details.jobs;
  // jobs.json stores as { "jobs": { "<id>": {...}, ... } } map
  if (data.jobs && typeof data.jobs === 'object' && !Array.isArray(data.jobs)) {
    return Object.values(data.jobs);
  }
  if (data.jobId || data.name) return [data];
  return [];
}

module.exports = {
  invokeTool,
  sessionsList,
  sessionsHistory,
  cronList,
  parseJsonWithLiteralNewlines,
  sleep,
  isRetryableError
};
