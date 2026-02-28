/**
 * Integration tests for GET /api/v1/tasks/:id/subagents
 *
 * Tests verify:
 * - Task-scoped subagent filtering
 * - Merge of runtime + gateway session data
 * - Failed status mapping via abortedLastRun
 * - Graceful degradation when gateway unavailable
 * - Service not configured error (503)
 * - Authentication requirements (401)
 *
 * Mocks openclawGatewayClient and pool so tests run without real OpenClaw or DB.
 */

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  end: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock OpenClaw gateway before requiring tasks router (avoids WebSocket/fetch leaks)
jest.mock('../../services/openclawGatewayClient', () => ({
  sessionsList: jest.fn(),
  sessionsHistory: jest.fn(),
  invokeTool: jest.fn(),
  sessionsListAllViaWs: jest.fn(),
  sessionsHistoryViaWs: jest.fn(),
  gatewayWsRpc: jest.fn(),
  cronList: jest.fn(),
  parseJsonWithLiteralNewlines: jest.fn((x) => (typeof x === 'string' ? JSON.parse(x) : x)),
  sleep: jest.fn((ms) => new Promise((r) => setTimeout(r, ms))),
  isRetryableError: jest.fn(() => false),
}));

const tasksRouter = require('../tasks');
const openclawGatewayClient = require('../../services/openclawGatewayClient');
const pool = require('../../db/pool');

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production';
  return jwt.sign({ id: userId, role, email: `${role}@example.com` }, jwtSecret, {
    expiresIn: '1h',
  });
}

describe('GET /api/v1/tasks/:id/subagents', () => {
  let app;
  let originalFetch;
  let mockWorkspaceUrl;

  beforeAll(() => {
    // Create Express app with routes
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksRouter);

    // Add error handler middleware (matching main app)
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({
        error: {
          message: err.message || 'Internal server error',
          status: err.status || 500,
        },
      });
    });

    pool.query.mockImplementation(async (query, params) => {
      // Mock user lookup for authenticateToken middleware
      if (query.includes('SELECT id, name, email, role, active FROM users WHERE id')) {
        const userId = params[0];
        return {
          rows: [
            {
              id: userId,
              name: 'Test User',
              email: 'test@example.com',
              role: 'user',
              active: true,
            },
          ],
        };
      }

      // Mock task existence check
      if (query.includes('SELECT id, task_number FROM tasks WHERE id')) {
        const taskId = params[0];
        if (taskId === '404e4567-e89b-12d3-a456-426614174404') {
          return { rows: [] };
        }
        return {
          rows: [{ id: taskId, task_number: 123 }],
        };
      }

      // Mock task number lookup for runtime service
      if (query.includes('SELECT id, task_number FROM tasks WHERE id IN')) {
        const taskIds = params || [];
        return {
          rows: taskIds.map((id, idx) => ({
            id,
            task_number: 100 + idx,
          })),
        };
      }

      return { rows: [] };
    });

    // Mock fetch for workspace service (runtime files)
    originalFetch = global.fetch;
    mockWorkspaceUrl = 'http://mock-workspace:8080';
    process.env.OPENCLAW_WORKSPACE_URL = mockWorkspaceUrl;
    // OPENCLAW_GATEWAY_URL not needed — openclawGatewayClient is mocked
  });

  afterAll(() => {
    global.fetch = originalFetch;
    delete process.env.OPENCLAW_WORKSPACE_URL;
  });

  beforeEach(() => {
    // Reset fetch mock before each test
    global.fetch = jest.fn();
    // Default: gateway returns empty (no sessions) — tests override when needed
    openclawGatewayClient.sessionsList.mockResolvedValue([]);
    openclawGatewayClient.sessionsHistory.mockResolvedValue([]);
  });

  describe('Happy path: runtime + gateway merge', () => {
    it('should return task-scoped subagents with runtime and gateway data merged', async () => {
      const token = getToken('user-id', 'user');
      const taskId = '123e4567-e89b-12d3-a456-426614174000'; // Valid UUID

      // Mock gateway: sessions with tokens
      openclawGatewayClient.sessionsList.mockResolvedValue([
        {
          key: 'agent:main:subagent:abc',
          displayName: `mosbot-task-${taskId}-001`,
          kind: 'other',
          model: 'sonnet',
          totalTokens: 15000,
          abortedLastRun: false,
        },
      ]);
      openclawGatewayClient.sessionsHistory.mockResolvedValue([
        { role: 'user', content: 'Do the task' },
        { role: 'assistant', content: 'Task completed successfully' },
      ]);

      // Mock workspace service responses (runtime files)
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-active.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: `{"sessionKey":"agent:main:subagent:abc","sessionLabel":"mosbot-task-${taskId}-001","taskId":"${taskId}","model":"sonnet","startedAt":"2026-02-10T09:00:00Z"}\n`,
            }),
          };
        }
        if (url.includes('spawn-requests.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: `{"requests":[{"taskId":"${taskId}","title":"Test task","status":"SPAWN_QUEUED","model":"haiku","queuedAt":"2026-02-10T08:00:00Z"}]}`,
            }),
          };
        }
        if (url.includes('results-cache.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: `{"sessionLabel":"mosbot-task-${taskId}-002","taskId":"${taskId}","cachedAt":"2026-02-09T10:00:00Z","outcome":"✅ Task Complete"}\n`,
            }),
          };
        }
        if (url.includes('activity-log.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: `{"sessionLabel":"mosbot-task-${taskId}-002","timestamp":"2026-02-09T09:45:00Z","category":"orchestration:spawn"}\n`,
            }),
          };
        }

        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'Not found' }),
          text: async () => 'Not found',
        };
      });

      const response = await request(app)
        .get(`/api/v1/tasks/${taskId}/subagents`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.meta).toMatchObject({
        total: expect.any(Number),
        running: expect.any(Number),
        completed: expect.any(Number),
        failed: expect.any(Number),
        queued: expect.any(Number),
      });

      // Should have running, queued, and completed
      const statuses = response.body.data.map((a) => a.status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('queued');
      expect(statuses).toContain('completed');

      // Running attempt should have gateway enrichment (tokens)
      const runningAttempt = response.body.data.find((a) => a.status === 'running');
      expect(runningAttempt).toMatchObject({
        taskId,
        status: 'running',
        model: 'sonnet',
        tokensUsed: 15000,
      });
    });
  });

  describe('Runtime-only fallback', () => {
    it('should work when gateway is not available', async () => {
      const token = getToken('user-id', 'user');
      const taskId = '456e4567-e89b-12d3-a456-426614174001'; // Valid UUID

      // Mock workspace service responses
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-active.jsonl')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: `{"sessionKey":"agent:main:subagent:def","sessionLabel":"mosbot-task-${taskId}-001","taskId":"${taskId}","model":"sonnet","startedAt":"2026-02-10T09:00:00Z"}\n`,
            }),
          };
        }
        if (url.includes('spawn-requests.json')) {
          return { ok: true, status: 200, json: async () => ({ content: '{"requests":[]}' }) };
        }
        if (url.includes('results-cache.jsonl')) {
          return { ok: true, status: 200, json: async () => ({ content: '' }) };
        }
        if (url.includes('activity-log.jsonl')) {
          return { ok: true, status: 200, json: async () => ({ content: '' }) };
        }

        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'Not found' }),
          text: async () => 'Not found',
        };
      });

      const response = await request(app)
        .get(`/api/v1/tasks/${taskId}/subagents`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThan(0);

      // Should still have runtime data
      const runningAttempt = response.body.data.find((a) => a.status === 'running');
      expect(runningAttempt).toMatchObject({
        taskId,
        status: 'running',
        model: 'sonnet',
      });
    });
  });

  describe('Failed status mapping', () => {
    it('should map abortedLastRun to failed status', async () => {
      const token = getToken('user-id', 'user');
      const taskId = '789e4567-e89b-12d3-a456-426614174002'; // Valid UUID

      // Mock gateway: session with abortedLastRun (maps to failed)
      openclawGatewayClient.sessionsList.mockResolvedValue([
        {
          key: 'agent:main:subagent:failed',
          displayName: `mosbot-task-${taskId}-001`,
          kind: 'other',
          model: 'sonnet',
          abortedLastRun: true,
        },
      ]);
      openclawGatewayClient.sessionsHistory.mockResolvedValue([]);

      // Mock workspace service responses (empty runtime)
      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-active.jsonl')) {
          return { ok: true, status: 200, json: async () => ({ content: '' }) };
        }
        if (url.includes('spawn-requests.json')) {
          return { ok: true, status: 200, json: async () => ({ content: '{"requests":[]}' }) };
        }
        if (url.includes('results-cache.jsonl')) {
          return { ok: true, status: 200, json: async () => ({ content: '' }) };
        }
        if (url.includes('activity-log.jsonl')) {
          return { ok: true, status: 200, json: async () => ({ content: '' }) };
        }

        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'Not found' }),
          text: async () => 'Not found',
        };
      });

      const response = await request(app)
        .get(`/api/v1/tasks/${taskId}/subagents`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.meta.failed).toBeGreaterThan(0);

      const failedAttempt = response.body.data.find((a) => a.status === 'failed');
      expect(failedAttempt).toBeTruthy();
      expect(failedAttempt.sessionKey).toBe('agent:main:subagent:failed');
    });
  });

  describe('Error handling', () => {
    it('should return 404 when task does not exist', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/tasks/404e4567-e89b-12d3-a456-426614174404/subagents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body.error.message).toContain('Task not found');
    });

    it('should return 401 when no token provided', async () => {
      const response = await request(app).get('/api/v1/tasks/task-123/subagents');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toContain('No token provided');
    });

    it('should return 503 when workspace service not configured', async () => {
      const token = getToken('user-id', 'user');
      const taskId = '999e4567-e89b-12d3-a456-426614174999'; // Valid UUID

      // Temporarily remove env var
      const originalUrl = process.env.OPENCLAW_WORKSPACE_URL;
      delete process.env.OPENCLAW_WORKSPACE_URL;

      global.fetch = jest.fn().mockImplementation(async (url) => {
        if (url.includes('spawn-active.jsonl')) {
          const err = new Error('OpenClaw workspace service is not configured');
          err.code = 'SERVICE_NOT_CONFIGURED';
          err.status = 503;
          throw err;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'Not found' }),
          text: async () => 'Not found',
        };
      });

      const response = await request(app)
        .get(`/api/v1/tasks/${taskId}/subagents`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(503);

      // Restore env var
      process.env.OPENCLAW_WORKSPACE_URL = originalUrl;
    });
  });
});
