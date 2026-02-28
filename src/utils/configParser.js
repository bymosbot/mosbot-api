/**
 * Utility for parsing OpenClaw config files (JSON5 format)
 * OpenClaw uses JSON5 which supports trailing commas, comments, and other features
 * not available in strict JSON.
 */

let json5 = null;

/**
 * Lazy-load json5 module (optional dependency)
 */
function getJson5Parser() {
  if (json5 === null) {
    try {
      json5 = require('json5');
    } catch (_err) {
      // json5 not installed - fall back to JSON.parse with error handling
      return null;
    }
  }
  return json5;
}

/**
 * Parse OpenClaw config content (JSON5 format)
 * Falls back to JSON.parse if json5 is not available
 * @param {string} content - JSON5 content string
 * @returns {object} Parsed config object
 * @throws {Error} If parsing fails
 */
function parseOpenClawConfig(content) {
  const parser = getJson5Parser();

  if (parser) {
    // Use JSON5 parser
    return parser.parse(content);
  } else {
    // Fall back to JSON.parse (will fail on JSON5 features like trailing commas)
    try {
      return JSON.parse(content);
    } catch (_err) {
      throw new Error(
        `Failed to parse config: ${_err.message}. ` +
          "Install 'json5' package for JSON5 support (trailing commas, comments, etc.)",
      );
    }
  }
}

module.exports = {
  parseOpenClawConfig,
};
