/**
 * Central configuration module.
 *
 * All process.env reads, type coercions, and default values live here.
 * Import this module instead of reading process.env directly in application code.
 *
 * Call config.validate() once at startup (src/index.js) to catch missing
 * required variables before the server accepts any traffic.
 *
 * Note: variables that tests override via process.env mutation are read lazily
 * inside functions (e.g. openclaw.gatewayUrl) so test setup continues to work
 * without requiring jest.resetModules().
 */

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  timezone: process.env.TIMEZONE || 'UTC',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  openclaw: {
    /**
     * workspaceUrl is read lazily in route handlers so that tests can override
     * process.env.OPENCLAW_WORKSPACE_URL before each test case.
     */
    get workspaceUrl() {
      return process.env.OPENCLAW_WORKSPACE_URL || null;
    },
    /**
     * gatewayUrl falls back to the in-cluster address in production.
     * Read lazily so tests can override process.env.OPENCLAW_GATEWAY_URL.
     */
    get gatewayUrl() {
      return (
        process.env.OPENCLAW_GATEWAY_URL ||
        (process.env.NODE_ENV === 'production'
          ? 'http://openclaw.agents.svc.cluster.local:18789'
          : null)
      );
    },
    get gatewayToken() {
      return process.env.OPENCLAW_GATEWAY_TOKEN || null;
    },
    gatewayTimeoutMs: parseInt(process.env.OPENCLAW_GATEWAY_TIMEOUT_MS || '15000', 10),
    device: {
      get id() {
        return process.env.OPENCLAW_DEVICE_ID || null;
      },
      get publicKey() {
        return process.env.OPENCLAW_DEVICE_PUBLIC_KEY || null;
      },
      get privateKey() {
        return process.env.OPENCLAW_DEVICE_PRIVATE_KEY || null;
      },
      get token() {
        return process.env.OPENCLAW_DEVICE_TOKEN || null;
      },
    },
    get workspaceToken() {
      return process.env.OPENCLAW_WORKSPACE_TOKEN || null;
    },
    subagentRetentionDays: parseInt(process.env.SUBAGENT_RETENTION_DAYS || '30', 10),
    activityLogRetentionDays: parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS || '7', 10),
  },

  polling: {
    sessionUsageIntervalMs: parseInt(process.env.SESSION_USAGE_POLL_INTERVAL_MS || '60000', 10),
    modelPricingRefreshIntervalMs: parseInt(
      process.env.MODEL_PRICING_REFRESH_INTERVAL_MS || String(7 * 24 * 60 * 60 * 1000),
      10,
    ),
    activityCronIntervalMs: parseInt(process.env.ACTIVITY_CRON_POLL_INTERVAL_MS || '120000', 10),
    activitySubagentIntervalMs: parseInt(
      process.env.ACTIVITY_SUBAGENT_POLL_INTERVAL_MS || '180000',
      10,
    ),
  },

  bootstrap: {
    ownerEmail: process.env.BOOTSTRAP_OWNER_EMAIL || null,
    ownerPassword: process.env.BOOTSTRAP_OWNER_PASSWORD || null,
    ownerName: process.env.BOOTSTRAP_OWNER_NAME || 'Owner',
  },

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || null,
  },

  retention: {
    archiveEnabled: process.env.RETENTION_ARCHIVE_ENABLED === 'true',
  },

  /**
   * Validate required configuration at startup.
   * Throws an Error listing all missing variables so the process exits cleanly
   * before accepting any traffic.
   */
  validate() {
    const missing = [];

    if (!this.jwt.secret) missing.push('JWT_SECRET');

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}. ` +
          'Check your .env file or deployment secrets.',
      );
    }

    if (this.corsOrigin === '*') {
      throw new Error(
        'CORS_ORIGIN cannot be "*" when credentials are enabled. ' +
          'Set CORS_ORIGIN to the exact dashboard origin.',
      );
    }
  },
};

module.exports = config;
