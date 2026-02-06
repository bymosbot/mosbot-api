/* eslint-disable no-console */
/**
 * Simple structured logger utility
 * Formats logs with timestamps and structured data for better observability
 */

/**
 * Format log entry with timestamp and structured data
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 * @param {object} metadata - Additional structured data
 */
function log(level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level: level.toUpperCase(),
    message,
    ...metadata
  };
  
  // Use appropriate console method based on level
  const logMethod = level === 'error' ? console.error : 
                    level === 'warn' ? console.warn : 
                    console.log;
  
  logMethod(JSON.stringify(logEntry));
}

/**
 * Log info level messages
 */
function info(message, metadata) {
  log('info', message, metadata);
}

/**
 * Log warning level messages
 */
function warn(message, metadata) {
  log('warn', message, metadata);
}

/**
 * Log error level messages
 */
function error(message, metadata) {
  log('error', message, metadata);
}

module.exports = {
  info,
  warn,
  error
};
