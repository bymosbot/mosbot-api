const logger = require('../utils/logger');
const { getFileContent } = require('./openclawWorkspaceClient');
const pool = require('../db/pool');

// Cache for empty/missing file responses to reduce OpenClaw load
// When files don't exist (404), cache the empty result for a short time
const emptyFileCache = new Map();
const EMPTY_CACHE_TTL_MS = 15000; // 15 seconds

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

// Helper to get file content with caching for empty/missing files
async function getCachedFileContent(path) {
  // Check cache first
  const cached = emptyFileCache.get(path);
  if (cached && Date.now() < cached.expiresAt) {
    return null; // Return cached empty result
  }

  // Fetch from OpenClaw
  const content = await getFileContent(path);
  
  // If file is missing or empty, cache the result
  if (!content) {
    emptyFileCache.set(path, {
      expiresAt: Date.now() + EMPTY_CACHE_TTL_MS
    });
  } else {
    // File exists - remove from cache if it was there
    emptyFileCache.delete(path);
  }
  
  return content;
}

/**
 * Fetch and parse runtime subagent files from OpenClaw workspace
 * @param {object} options - Query options
 * @param {string} options.taskId - Optional: filter by single task ID
 * @returns {Promise<object>} Parsed subagent data { running, queued, completed, activityBySession }
 */
async function fetchRuntimeSubagents({ taskId } = {}) {
  // Read all runtime files (fail gracefully if missing)
  // Rethrow SERVICE_NOT_CONFIGURED so we return 503 instead of empty data
  // Use cached file fetcher to reduce load when files are missing
  const wrapCatch = (p) => p.catch((err) => {
    if (err.code === 'SERVICE_NOT_CONFIGURED') throw err;
    return null;
  });
  
  const [spawnActiveContent, spawnRequestsContent, resultsCacheContent, activityLogContent] = await Promise.all([
    wrapCatch(getCachedFileContent('/runtime/mosbot/spawn-active.jsonl')),
    wrapCatch(getCachedFileContent('/runtime/mosbot/spawn-requests.json')),
    wrapCatch(getCachedFileContent('/runtime/mosbot/results-cache.jsonl')),
    wrapCatch(getCachedFileContent('/runtime/mosbot/activity-log.jsonl'))
  ]);
  
  // Parse running subagents from spawn-active.jsonl
  let runningRaw = parseJsonl(spawnActiveContent).map(entry => ({
    sessionKey: entry.sessionKey || null,
    sessionLabel: entry.sessionLabel || null,
    taskId: entry.taskId || null,
    status: 'RUNNING',
    model: entry.model || null,
    startedAt: entry.startedAt || null,
    timeoutMinutes: entry.timeoutMinutes || null
  }));
  
  // Filter by taskId if provided
  if (taskId) {
    runningRaw = runningRaw.filter(r => r.taskId === taskId);
  }
  
  // Parse queued subagents from spawn-requests.json
  let queuedRaw = [];
  if (spawnRequestsContent) {
    try {
      const spawnRequests = JSON.parse(spawnRequestsContent);
      queuedRaw = (spawnRequests.requests || [])
        .filter(r => r.status === 'SPAWN_QUEUED')
        .map(r => ({
          taskId: r.taskId || null,
          title: r.title || null,
          status: 'SPAWN_QUEUED',
          model: r.model || null,
          queuedAt: r.queuedAt || null
        }));
      
      // Filter by taskId if provided
      if (taskId) {
        queuedRaw = queuedRaw.filter(q => q.taskId === taskId);
      }
    } catch (err) {
      // Invalid JSON, leave queued empty
      logger.warn('Failed to parse spawn-requests.json', { error: err.message });
    }
  }
  
  // Parse activity log for timestamp enrichment
  const activityEntries = parseJsonl(activityLogContent);
  const activityBySession = new Map();
  
  activityEntries.forEach(entry => {
    // Activity log uses metadata.session_label and task_id (with underscore)
    const sessionLabel = entry.metadata?.session_label || entry.sessionLabel;
    const entryTaskId = entry.task_id || entry.taskId;
    const key = sessionLabel || entryTaskId;
    
    // Skip if taskId filter is set and doesn't match
    if (taskId && entryTaskId && entryTaskId !== taskId) {
      return;
    }
    
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
    
    // Filter by taskId if provided
    if (taskId && entry.taskId && entry.taskId !== taskId) {
      return;
    }
    
    const existing = completedMap.get(key);
    const entryCachedAt = entry.cachedAt || entry.timestamp || '';
    
    if (!existing || (entryCachedAt > (existing.cachedAt || existing.timestamp || ''))) {
      completedMap.set(key, entry);
    }
  });
  
  // Map completed entries with activity log enrichment
  const completedRaw = Array.from(completedMap.values()).map(entry => {
    const sessionLabel = entry.sessionLabel;
    const entryTaskId = entry.taskId || null;
    const completedAt = entry.cachedAt || entry.timestamp || null;
    
    // Try to find start time from activity log
    let startedAt = null;
    let durationSeconds = null;
    
    const activities = activityBySession.get(sessionLabel) || activityBySession.get(entryTaskId) || [];
    // Look for orchestration:spawn event which marks subagent start
    const startEvent = activities.find(a => 
      a.category === 'orchestration:spawn' ||
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
      taskId: entryTaskId,
      status: 'COMPLETED',
      outcome: entry.outcome || null,
      startedAt,
      completedAt,
      durationSeconds
    };
  });
  
  return {
    running: runningRaw,
    queued: queuedRaw,
    completed: completedRaw,
    activityBySession
  };
}

/**
 * Enrich subagent data with task numbers from database
 * @param {Array} running - Running subagents
 * @param {Array} queued - Queued subagents
 * @param {Array} completed - Completed subagents
 * @returns {Promise<object>} Enriched data { running, queued, completed }
 */
async function enrichWithTaskNumbers(running, queued, completed) {
  // Collect all unique task IDs from running, queued, and completed
  const allTaskIds = new Set();
  running.forEach(r => r.taskId && allTaskIds.add(r.taskId));
  queued.forEach(q => q.taskId && allTaskIds.add(q.taskId));
  completed.forEach(c => c.taskId && allTaskIds.add(c.taskId));
  
  // Fetch task numbers for all task IDs in one query
  const taskNumberMap = new Map();
  if (allTaskIds.size > 0) {
    const taskIdsArray = Array.from(allTaskIds);
    const placeholders = taskIdsArray.map((_, i) => `$${i + 1}`).join(',');
    const taskQuery = await pool.query(
      `SELECT id, task_number FROM tasks WHERE id IN (${placeholders})`,
      taskIdsArray
    );
    taskQuery.rows.forEach(row => {
      taskNumberMap.set(row.id, row.task_number);
    });
  }
  
  // Enrich with task numbers
  const runningEnriched = running.map(r => ({
    ...r,
    taskNumber: r.taskId ? taskNumberMap.get(r.taskId) || null : null
  }));
  
  const queuedEnriched = queued.map(q => ({
    ...q,
    taskNumber: q.taskId ? taskNumberMap.get(q.taskId) || null : null
  }));
  
  const completedEnriched = completed.map(c => ({
    ...c,
    taskNumber: c.taskId ? taskNumberMap.get(c.taskId) || null : null
  }));
  
  return {
    running: runningEnriched,
    queued: queuedEnriched,
    completed: completedEnriched
  };
}

/**
 * Get all subagents with task number enrichment
 * @param {object} options - Query options
 * @param {string} options.taskId - Optional: filter by single task ID
 * @returns {Promise<object>} { running, queued, completed }
 */
async function getAllSubagents({ taskId } = {}) {
  const { running, queued, completed } = await fetchRuntimeSubagents({ taskId });
  return enrichWithTaskNumbers(running, queued, completed);
}

module.exports = {
  parseJsonl,
  fetchRuntimeSubagents,
  enrichWithTaskNumbers,
  getAllSubagents
};
