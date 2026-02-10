const pool = require('../db/pool');
const logger = require('../utils/logger');
const { getFileContent, putFileContent } = require('../services/openclawWorkspaceClient');

// Postgres advisory lock ID for subagent retention purge job (unique 64-bit integer)
const PURGE_LOCK_ID = 987654321;

/**
 * Parse JSONL content into array of lines (preserving malformed lines)
 * @param {string} content - JSONL file content
 * @returns {Array<{line: string, parsed: Object|null}>} Array of line objects
 */
function parseJsonlLines(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }
  
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try {
        return { line, parsed: JSON.parse(line) };
      } catch (_err) {
        // Keep malformed lines (fail-safe)
        return { line, parsed: null };
      }
    });
}

/**
 * Purge a JSONL file based on timestamp field and cutoff
 * @param {string} filePath - Workspace file path
 * @param {string} dateField - Field name to check for timestamp
 * @param {string} cutoffIso - Cutoff timestamp in ISO format
 * @returns {Promise<{kept: number, purged: number, purgedLines: Array}>}
 */
async function purgeJsonlFile(filePath, dateField, cutoffIso) {
  try {
    const content = await getFileContent(filePath);
    
    if (!content) {
      logger.info(`File not found or empty: ${filePath}`);
      return { kept: 0, purged: 0, purgedLines: [] };
    }
    
    const lines = parseJsonlLines(content);
    const kept = [];
    const purged = [];
    
    for (const { line, parsed } of lines) {
      if (!parsed) {
        // Keep malformed lines for safety
        kept.push(line);
      } else if (parsed[dateField] && parsed[dateField] >= cutoffIso) {
        // Keep entries newer than cutoff
        kept.push(line);
      } else {
        // Purge old entries
        purged.push({ line, parsed });
      }
    }
    
    // Rewrite file with kept entries
    if (kept.length > 0) {
      await putFileContent(filePath, kept.join('\n') + '\n', 'utf8');
    } else {
      // If nothing to keep, write empty file
      await putFileContent(filePath, '', 'utf8');
    }
    
    logger.info(`Purged ${filePath}`, { kept: kept.length, purged: purged.length });
    
    return { kept: kept.length, purged: purged.length, purgedLines: purged };
  } catch (error) {
    logger.error(`Failed to purge ${filePath}`, { error: error.message });
    throw error;
  }
}

/**
 * Archive purged entries to monthly archive file
 * @param {string} baseFileName - Base file name (e.g., 'results-cache')
 * @param {Array} purgedLines - Array of {line, parsed} objects
 */
async function archivePurgedEntries(baseFileName, purgedLines) {
  if (purgedLines.length === 0) {
    return;
  }
  
  try {
    const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const archivePath = `/runtime/mosbot/archive/${baseFileName}-${yearMonth}.jsonl`;
    
    // Read existing archive file if present
    const existingContent = await getFileContent(archivePath).catch(() => '');
    
    // Append purged lines
    const purgedContent = purgedLines.map(p => p.line).join('\n') + '\n';
    const newContent = existingContent ? existingContent + purgedContent : purgedContent;
    
    await putFileContent(archivePath, newContent, 'utf8');
    
    logger.info(`Archived ${purgedLines.length} entries to ${archivePath}`);
  } catch (error) {
    logger.error(`Failed to archive ${baseFileName}`, { error: error.message });
    // Don't throw - archiving is optional, main purge should still succeed
  }
}

/**
 * Purge old subagent data from OpenClaw workspace runtime files
 * Uses Postgres advisory lock to ensure only one instance runs at a time
 * @param {number} completedRetentionDays - Days to retain completed subagents (default 30)
 * @param {number} activityRetentionDays - Days to retain activity logs (default 7)
 * @returns {Promise<{resultsKept: number, resultsPurged: number, activityKept: number, activityPurged: number}>}
 */
async function purgeSubagentData(completedRetentionDays = 30, activityRetentionDays = 7) {
  const client = await pool.connect();
  
  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [PURGE_LOCK_ID]);
    
    if (!lockResult.rows[0].acquired) {
      logger.info('Subagent retention purge job already running on another instance, skipping...');
      return { resultsKept: 0, resultsPurged: 0, activityKept: 0, activityPurged: 0 };
    }
    
    logger.info('Acquired advisory lock for subagent retention purge job');
    
    const now = Date.now();
    const resultsRetentionMs = completedRetentionDays * 24 * 60 * 60 * 1000;
    const activityRetentionMs = activityRetentionDays * 24 * 60 * 60 * 1000;
    
    const resultsCutoff = new Date(now - resultsRetentionMs).toISOString();
    const activityCutoff = new Date(now - activityRetentionMs).toISOString();
    
    logger.info('Starting subagent data retention purge', {
      completedRetentionDays,
      activityRetentionDays,
      resultsCutoff,
      activityCutoff
    });
    
    // Purge results-cache.jsonl
    const resultsResult = await purgeJsonlFile(
      '/runtime/mosbot/results-cache.jsonl',
      'cachedAt',
      resultsCutoff
    );
    
    // Purge activity-log.jsonl
    const activityResult = await purgeJsonlFile(
      '/runtime/mosbot/activity-log.jsonl',
      'timestamp',
      activityCutoff
    );
    
    // Archive if enabled
    if (process.env.RETENTION_ARCHIVE_ENABLED === 'true') {
      await archivePurgedEntries('results-cache', resultsResult.purgedLines);
      await archivePurgedEntries('activity-log', activityResult.purgedLines);
    }
    
    // Release advisory lock
    await client.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_ID]);
    logger.info('Released advisory lock');
    
    logger.info('Subagent retention purge completed', {
      resultsKept: resultsResult.kept,
      resultsPurged: resultsResult.purged,
      activityKept: activityResult.kept,
      activityPurged: activityResult.purged
    });
    
    return {
      resultsKept: resultsResult.kept,
      resultsPurged: resultsResult.purged,
      activityKept: activityResult.kept,
      activityPurged: activityResult.purged
    };
  } catch (error) {
    logger.error('Subagent retention purge job failed', { error: error.message });
    
    // Try to release lock on error
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_ID]);
    } catch (unlockError) {
      logger.error('Failed to release advisory lock', { error: unlockError.message });
    }
    
    throw error;
  } finally {
    client.release();
  }
}

module.exports = purgeSubagentData;
