/**
 * Tests for src/index.js - Express app setup and middleware
 */

const request = require('supertest');

// Mock dependencies before requiring index.js
jest.mock('../db/runMigrations', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../services/sessionUsageService', () => ({
  startSessionUsagePoller: jest.fn(),
}));
jest.mock('../services/modelPricingService', () => ({
  startPricingRefreshJob: jest.fn(),
}));
jest.mock('../services/activityIngestionService', () => ({
  startActivityIngestionPollers: jest.fn(),
}));
jest.mock('../services/openclawGatewayClient', () => ({
  warnIfDeviceAuthNotConfigured: jest.fn(),
}));
jest.mock('../services/docsLinkReconciliationService', () => ({
  reconcileDocsLinksOnStartup: jest.fn().mockResolvedValue({
    main: { action: 'unchanged' },
    agents: [],
  }),
}));
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

// Mock config
jest.mock('../config', () => ({
  validate: jest.fn(),
  corsOrigin: 'http://localhost:5173',
  timezone: 'America/New_York',
  port: 3000,
  nodeEnv: 'test',
  polling: {
    sessionUsageIntervalMs: 60000,
    modelPricingRefreshIntervalMs: 3600000,
  },
}));

// Mock Express app.listen to prevent server from starting
const mockListen = jest.fn((port, callback) => {
  if (callback) callback();
  return { close: jest.fn() };
});

jest.mock('express', () => {
  const express = jest.requireActual('express');
  const app = express();
  app.listen = mockListen;
  return express;
});

// Import app after mocks
const app = require('../index');

describe('Express App Setup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
    });
  });

  describe('GET /api/v1/config', () => {
    it('should return public config', async () => {
      const response = await request(app).get('/api/v1/config');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: {
          timezone: 'America/New_York',
        },
      });
    });
  });

  describe('CORS middleware', () => {
    it('should allow requests with no origin', async () => {
      const response = await request(app).get('/health').set('Origin', '');

      expect(response.status).toBe(200);
    });

    it('should allow requests from configured CORS origin', async () => {
      const response = await request(app).get('/health').set('Origin', 'http://localhost:5173');

      expect(response.status).toBe(200);
    });

    it('should reject requests from non-configured origins', async () => {
      const response = await request(app).get('/health').set('Origin', 'http://evil.com');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Error handling middleware', () => {
    it('should handle errors with status code', async () => {
      const express = require('express');
      const testApp = express();
      testApp.get('/test-error', (req, res, next) => {
        const err = new Error('Test error');
        err.status = 400;
        next(err);
      });
      // Replicate the error handler from index.js
      testApp.use((err, req, res, _next) => {
        res.status(err.status || 500).json({
          error: {
            message: err.message || 'Internal server error',
            status: err.status || 500,
          },
        });
      });

      const response = await request(testApp).get('/test-error');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: 'Test error',
          status: 400,
        },
      });
    });

    it('should handle errors without status code', async () => {
      const express = require('express');
      const testApp = express();
      testApp.get('/test-error-no-status', (req, res, next) => {
        const err = new Error('Internal error');
        next(err);
      });
      testApp.use((err, req, res, _next) => {
        res.status(err.status || 500).json({
          error: {
            message: err.message || 'Internal server error',
            status: err.status || 500,
          },
        });
      });

      const response = await request(testApp).get('/test-error-no-status');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          message: 'Internal error',
          status: 500,
        },
      });
    });

    it('should handle errors without message', async () => {
      const express = require('express');
      const testApp = express();
      testApp.get('/test-error-no-message', (req, res, next) => {
        const err = {};
        err.status = 500;
        next(err);
      });
      testApp.use((err, req, res, _next) => {
        res.status(err.status || 500).json({
          error: {
            message: err.message || 'Internal server error',
            status: err.status || 500,
          },
        });
      });

      const response = await request(testApp).get('/test-error-no-message');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          message: 'Internal server error',
          status: 500,
        },
      });
    });
  });

  describe('404 handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/unknown/route');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          message: 'Not found',
          status: 404,
        },
      });
    });
  });
});
