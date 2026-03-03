/**
 * Tests for config.js - configuration validation and getters
 */

describe('config', () => {
  const originalEnv = process.env;
  let config;

  beforeEach(() => {
    // Reset module cache to get fresh config
    jest.resetModules();
    // Reset process.env for each test
    process.env = { ...originalEnv };
    // Ensure JWT_SECRET is set (required for tests)
    process.env.JWT_SECRET = 'test-secret';
    // Require config after env is set
    config = require('../config');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('validate()', () => {
    it('should throw error when JWT_SECRET is missing', () => {
      jest.resetModules();
      delete process.env.JWT_SECRET;
      const testConfig = require('../config');
      expect(() => {
        testConfig.validate();
      }).toThrow('Missing required environment variables: JWT_SECRET');
    });

    it('should throw error when CORS_ORIGIN is "*"', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.CORS_ORIGIN = '*';
      const testConfig = require('../config');
      expect(() => {
        testConfig.validate();
      }).toThrow('CORS_ORIGIN cannot be "*" when credentials are enabled');
    });

    it('should not throw when JWT_SECRET is set and CORS_ORIGIN is not "*"', () => {
      process.env.JWT_SECRET = 'test-secret';
      process.env.CORS_ORIGIN = 'http://localhost:5173';
      expect(() => {
        config.validate();
      }).not.toThrow();
    });

    it('should not throw when JWT_SECRET is set and CORS_ORIGIN is not set (uses default)', () => {
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.CORS_ORIGIN;
      expect(() => {
        config.validate();
      }).not.toThrow();
    });
  });

  describe('openclaw getters', () => {
    it('should return workspaceUrl from env var', () => {
      process.env.OPENCLAW_WORKSPACE_URL = 'http://test:3000';
      expect(config.openclaw.workspaceUrl).toBe('http://test:3000');
    });

    it('should return null when workspaceUrl is not set', () => {
      delete process.env.OPENCLAW_WORKSPACE_URL;
      expect(config.openclaw.workspaceUrl).toBeNull();
    });

    it('should return gatewayUrl from env var', () => {
      process.env.OPENCLAW_GATEWAY_URL = 'http://gateway:18789';
      expect(config.openclaw.gatewayUrl).toBe('http://gateway:18789');
    });

    it('should return production gatewayUrl when NODE_ENV is production and env var not set', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.OPENCLAW_GATEWAY_URL;
      expect(config.openclaw.gatewayUrl).toBe('http://openclaw.agents.svc.cluster.local:18789');
    });

    it('should return null when gatewayUrl is not set and not in production', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.OPENCLAW_GATEWAY_URL;
      expect(config.openclaw.gatewayUrl).toBeNull();
    });

    it('should return gatewayToken from env var', () => {
      process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
      expect(config.openclaw.gatewayToken).toBe('test-token');
    });

    it('should return null when gatewayToken is not set', () => {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      expect(config.openclaw.gatewayToken).toBeNull();
    });

    it('should return device.id from env var', () => {
      process.env.OPENCLAW_DEVICE_ID = 'device-123';
      expect(config.openclaw.device.id).toBe('device-123');
    });

    it('should return null when device.id is not set', () => {
      delete process.env.OPENCLAW_DEVICE_ID;
      expect(config.openclaw.device.id).toBeNull();
    });

    it('should return device.publicKey from env var', () => {
      process.env.OPENCLAW_DEVICE_PUBLIC_KEY = 'public-key';
      expect(config.openclaw.device.publicKey).toBe('public-key');
    });

    it('should return null when device.publicKey is not set', () => {
      delete process.env.OPENCLAW_DEVICE_PUBLIC_KEY;
      expect(config.openclaw.device.publicKey).toBeNull();
    });

    it('should return device.privateKey from env var', () => {
      process.env.OPENCLAW_DEVICE_PRIVATE_KEY = 'private-key';
      expect(config.openclaw.device.privateKey).toBe('private-key');
    });

    it('should return null when device.privateKey is not set', () => {
      delete process.env.OPENCLAW_DEVICE_PRIVATE_KEY;
      expect(config.openclaw.device.privateKey).toBeNull();
    });

    it('should return device.token from env var', () => {
      process.env.OPENCLAW_DEVICE_TOKEN = 'device-token';
      expect(config.openclaw.device.token).toBe('device-token');
    });

    it('should return null when device.token is not set', () => {
      delete process.env.OPENCLAW_DEVICE_TOKEN;
      expect(config.openclaw.device.token).toBeNull();
    });

    it('should return workspaceToken from env var', () => {
      process.env.OPENCLAW_WORKSPACE_TOKEN = 'workspace-token';
      expect(config.openclaw.workspaceToken).toBe('workspace-token');
    });

    it('should return null when workspaceToken is not set', () => {
      delete process.env.OPENCLAW_WORKSPACE_TOKEN;
      expect(config.openclaw.workspaceToken).toBeNull();
    });
  });

  describe('parsed values', () => {
    it('should parse gatewayTimeoutMs as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = '20000';
      const testConfig = require('../config');
      expect(testConfig.openclaw.gatewayTimeoutMs).toBe(20000);
    });

    it('should use default gatewayTimeoutMs when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.USE_STANDARD_CONFIG_VALUES = 'true'; // Ensure standard values are used
      delete process.env.OPENCLAW_GATEWAY_TIMEOUT_MS;
      const testConfig = require('../config');
      expect(testConfig.openclaw.gatewayTimeoutMs).toBe(15000);
      delete process.env.USE_STANDARD_CONFIG_VALUES; // Clean up
    });

    it('should parse subagentRetentionDays as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.SUBAGENT_RETENTION_DAYS = '60';
      const testConfig = require('../config');
      expect(testConfig.openclaw.subagentRetentionDays).toBe(60);
    });

    it('should use default subagentRetentionDays when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.SUBAGENT_RETENTION_DAYS;
      const testConfig = require('../config');
      expect(testConfig.openclaw.subagentRetentionDays).toBe(30);
    });

    it('should parse activityLogRetentionDays as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.ACTIVITY_LOG_RETENTION_DAYS = '14';
      const testConfig = require('../config');
      expect(testConfig.openclaw.activityLogRetentionDays).toBe(14);
    });

    it('should use default activityLogRetentionDays when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.ACTIVITY_LOG_RETENTION_DAYS;
      const testConfig = require('../config');
      expect(testConfig.openclaw.activityLogRetentionDays).toBe(7);
    });
  });

  describe('polling config', () => {
    it('should parse sessionUsageIntervalMs as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.SESSION_USAGE_POLL_INTERVAL_MS = '30000';
      const testConfig = require('../config');
      expect(testConfig.polling.sessionUsageIntervalMs).toBe(30000);
    });

    it('should use default sessionUsageIntervalMs when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.SESSION_USAGE_POLL_INTERVAL_MS;
      const testConfig = require('../config');
      expect(testConfig.polling.sessionUsageIntervalMs).toBe(60000);
    });

    it('should parse modelPricingRefreshIntervalMs as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.MODEL_PRICING_REFRESH_INTERVAL_MS = '86400000';
      const testConfig = require('../config');
      expect(testConfig.polling.modelPricingRefreshIntervalMs).toBe(86400000);
    });

    it('should use default modelPricingRefreshIntervalMs when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.MODEL_PRICING_REFRESH_INTERVAL_MS;
      const testConfig = require('../config');
      expect(testConfig.polling.modelPricingRefreshIntervalMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse activityCronIntervalMs as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.ACTIVITY_CRON_POLL_INTERVAL_MS = '60000';
      const testConfig = require('../config');
      expect(testConfig.polling.activityCronIntervalMs).toBe(60000);
    });

    it('should use default activityCronIntervalMs when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.ACTIVITY_CRON_POLL_INTERVAL_MS;
      const testConfig = require('../config');
      expect(testConfig.polling.activityCronIntervalMs).toBe(120000);
    });

    it('should parse activitySubagentIntervalMs as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.ACTIVITY_SUBAGENT_POLL_INTERVAL_MS = '120000';
      const testConfig = require('../config');
      expect(testConfig.polling.activitySubagentIntervalMs).toBe(120000);
    });

    it('should use default activitySubagentIntervalMs when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.ACTIVITY_SUBAGENT_POLL_INTERVAL_MS;
      const testConfig = require('../config');
      expect(testConfig.polling.activitySubagentIntervalMs).toBe(180000);
    });
  });

  describe('bootstrap config', () => {
    it('should return ownerEmail from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.BOOTSTRAP_OWNER_EMAIL = 'owner@example.com';
      const testConfig = require('../config');
      expect(testConfig.bootstrap.ownerEmail).toBe('owner@example.com');
    });

    it('should return null when ownerEmail is not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.BOOTSTRAP_OWNER_EMAIL;
      const testConfig = require('../config');
      expect(testConfig.bootstrap.ownerEmail).toBeNull();
    });

    it('should return ownerPassword from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.BOOTSTRAP_OWNER_PASSWORD = 'password123';
      const testConfig = require('../config');
      expect(testConfig.bootstrap.ownerPassword).toBe('password123');
    });

    it('should return null when ownerPassword is not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.BOOTSTRAP_OWNER_PASSWORD;
      const testConfig = require('../config');
      expect(testConfig.bootstrap.ownerPassword).toBeNull();
    });

    it('should return ownerName from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.BOOTSTRAP_OWNER_NAME = 'Test Owner';
      const testConfig = require('../config');
      expect(testConfig.bootstrap.ownerName).toBe('Test Owner');
    });

    it('should use default ownerName when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.BOOTSTRAP_OWNER_NAME;
      const testConfig = require('../config');
      expect(testConfig.bootstrap.ownerName).toBe('Owner');
    });
  });

  describe('openrouter config', () => {
    it('should return apiKey from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.OPENROUTER_API_KEY = 'sk-test-key';
      const testConfig = require('../config');
      expect(testConfig.openrouter.apiKey).toBe('sk-test-key');
    });

    it('should return null when apiKey is not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.OPENROUTER_API_KEY;
      const testConfig = require('../config');
      expect(testConfig.openrouter.apiKey).toBeNull();
    });
  });

  describe('retention config', () => {
    it('should return true when RETENTION_ARCHIVE_ENABLED is "true"', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.RETENTION_ARCHIVE_ENABLED = 'true';
      const testConfig = require('../config');
      expect(testConfig.retention.archiveEnabled).toBe(true);
    });

    it('should return false when RETENTION_ARCHIVE_ENABLED is not "true"', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.RETENTION_ARCHIVE_ENABLED = 'false';
      const testConfig = require('../config');
      expect(testConfig.retention.archiveEnabled).toBe(false);
    });

    it('should return false when RETENTION_ARCHIVE_ENABLED is not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.RETENTION_ARCHIVE_ENABLED;
      const testConfig = require('../config');
      expect(testConfig.retention.archiveEnabled).toBe(false);
    });
  });

  describe('basic config values', () => {
    it('should return nodeEnv from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.NODE_ENV = 'test';
      const testConfig = require('../config');
      expect(testConfig.nodeEnv).toBe('test');
    });

    it('should use default nodeEnv when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.NODE_ENV;
      const testConfig = require('../config');
      expect(testConfig.nodeEnv).toBe('development');
    });

    it('should parse port as integer', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.PORT = '8080';
      const testConfig = require('../config');
      expect(testConfig.port).toBe(8080);
    });

    it('should use default port when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.PORT;
      const testConfig = require('../config');
      expect(testConfig.port).toBe(3000);
    });

    it('should return timezone from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.TIMEZONE = 'America/New_York';
      const testConfig = require('../config');
      expect(testConfig.timezone).toBe('America/New_York');
    });

    it('should use default timezone when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.TIMEZONE;
      const testConfig = require('../config');
      expect(testConfig.timezone).toBe('UTC');
    });

    it('should return corsOrigin from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.CORS_ORIGIN = 'http://example.com';
      const testConfig = require('../config');
      expect(testConfig.corsOrigin).toBe('http://example.com');
    });

    it('should use default corsOrigin when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.CORS_ORIGIN;
      const testConfig = require('../config');
      expect(testConfig.corsOrigin).toBe('http://localhost:5173');
    });

    it('should return jwt.expiresIn from env var', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      process.env.JWT_EXPIRES_IN = '30d';
      const testConfig = require('../config');
      expect(testConfig.jwt.expiresIn).toBe('30d');
    });

    it('should use default jwt.expiresIn when not set', () => {
      jest.resetModules();
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.JWT_EXPIRES_IN;
      const testConfig = require('../config');
      expect(testConfig.jwt.expiresIn).toBe('7d');
    });
  });
});
