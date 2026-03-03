/**
 * Comprehensive tests for OpenClaw routes
 *
 * Tests cover:
 * - Workspace file operations (GET/POST/PUT/DELETE)
 * - Agents endpoint
 * - Org-chart endpoints
 * - Sessions endpoints
 * - Cron-jobs endpoints
 * - Usage endpoints
 * - Config endpoints
 * - Path validation and normalization
 * - Role-based access control
 *
 * Mocks pool and fetch so no live database or OpenClaw is needed.
 */

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  end: jest.fn(),
}));

jest.mock('../../services/activityLogService', () => ({
  recordActivityLogEventSafe: jest.fn(),
}));

jest.mock('../../services/openclawGatewayClient', () => ({
  cronList: jest.fn(),
  gatewayWsRpc: jest.fn(),
  sessionsListAllViaWs: jest.fn(),
  sessionsList: jest.fn(),
  sessionsHistory: jest.fn(),
}));

jest.mock('../../services/sessionUsageService', () => ({
  upsertSessionUsageBatch: jest.fn(),
}));

jest.mock('../../services/cronJobsService', () => ({
  createCronJob: jest.fn(),
  updateCronJob: jest.fn(),
  updateHeartbeatJob: jest.fn(),
  repairCronJobs: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const openclawRouter = require('../openclaw');
const pool = require('../../db/pool');
const { recordActivityLogEventSafe } = require('../../services/activityLogService');
const {
  cronList,
  gatewayWsRpc,
  sessionsListAllViaWs,
  sessionsHistory,
} = require('../../services/openclawGatewayClient');
const { createCronJob } = require('../../services/cronJobsService');
const { upsertSessionUsageBatch } = require('../../services/sessionUsageService');
const bcrypt = require('bcrypt');

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production';
  return jwt.sign({ id: userId, role, email: `${role}@example.com` }, jwtSecret, {
    expiresIn: '1h',
  });
}

describe('OpenClaw Routes', () => {
  let app;
  let originalFetch;
  let mockOpenClawUrl;

  beforeAll(() => {
    // Create Express app with routes
    app = express();
    app.use(express.json());
    app.use('/api/v1/openclaw', openclawRouter);

    // Add error handler middleware (matching main app)
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({
        error: {
          message: err.message || 'Internal server error',
          status: err.status || 500,
        },
      });
    });

    // Mock fetch globally
    originalFetch = global.fetch;
    mockOpenClawUrl = 'http://mock-openclaw:8080';
    process.env.OPENCLAW_WORKSPACE_URL = mockOpenClawUrl;
  });

  afterAll(() => {
    // Restore original fetch
    global.fetch = originalFetch;
    delete process.env.OPENCLAW_WORKSPACE_URL;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    recordActivityLogEventSafe.mockResolvedValue(undefined);
    cronList.mockResolvedValue([]);
    gatewayWsRpc.mockResolvedValue({});
    sessionsListAllViaWs.mockResolvedValue([]);
    sessionsHistory.mockResolvedValue({ messages: [] });
    upsertSessionUsageBatch.mockResolvedValue(undefined);
    pool.query.mockResolvedValue({ rows: [] });
  });

  describe('Path normalization and validation', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ files: [] }),
        text: async () => 'OK',
      });
    });

    it('should normalize relative paths to absolute', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: 'docs/test.md' });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2Fdocs%2Ftest.md'),
        expect.any(Object),
      );
    });

    it('should normalize Windows-style paths', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '\\docs\\test.md' });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2Fdocs%2Ftest.md'),
        expect.any(Object),
      );
    });

    it('should reject path traversal attempts', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/../etc/passwd' });

      // Path gets normalized to /etc/passwd which is then rejected as not allowed (403)
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PATH_NOT_ALLOWED');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject paths with multiple traversal attempts', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/docs/../../etc/passwd' });

      // Path gets normalized to /etc/passwd which is then rejected as not allowed (403)
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PATH_NOT_ALLOWED');
    });

    it('should allow root path', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/' });

      expect(response.status).toBe(200);
    });

    it('should default to root path when not provided', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2F'),
        expect.any(Object),
      );
    });
  });

  describe('Path access control', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ files: [] }),
        text: async () => 'OK',
      });
    });

    it('should allow access to /docs paths', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/docs/test.md' });

      expect(response.status).toBe(200);
    });

    it('should allow access to /projects paths', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/projects/test' });

      expect(response.status).toBe(200);
    });

    it('should allow access to /workspace paths', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace/test' });

      expect(response.status).toBe(200);
    });

    it('should reject access to disallowed paths', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/forbidden/path' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PATH_NOT_ALLOWED');
    });
  });

  describe('GET /api/v1/openclaw/workspace/files/content - docs access', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: 'Document content',
          size: 18,
          modified: new Date().toISOString(),
          encoding: 'utf8',
        }),
        text: async () => 'OK',
      });
    });

    it('should allow regular users to read /docs files', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/docs/readme.md' });

      expect(response.status).toBe(200);
      expect(response.body.data.content).toBe('Document content');
    });

    it('should allow regular users to read root /docs', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/docs' });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/openclaw/workspace/files - system config protection', () => {
    beforeEach(() => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async (_url, _options) => {
        callCount++;
        if (callCount === 1) {
          // Existence check - file doesn't exist
          return {
            ok: false,
            status: 404,
            text: async () => 'Not Found',
          };
        } else {
          // File creation succeeds
          return {
            ok: true,
            status: 201,
            json: async () => ({ path: '/openclaw.json', created: true }),
            text: async () => 'Created',
          };
        }
      });
    });

    it('should block agent role from creating system config files', async () => {
      const token = getToken('agent-id', 'agent');

      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/openclaw.json', content: '{}', encoding: 'utf8' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(response.body.error.message).toContain('System configuration files');
    });

    it('should allow admin to create system config files', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/openclaw.json', content: '{}', encoding: 'utf8' });

      expect(response.status).toBe(201);
    });

    it('should allow owner to create system config files', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/org-chart.json', content: '{}', encoding: 'utf8' });

      expect(response.status).toBe(201);
    });
  });

  describe('PUT /api/v1/openclaw/workspace/files - system config protection', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ path: '/openclaw.json', updated: true }),
        text: async () => 'OK',
      });
    });

    it('should block agent role from updating system config files', async () => {
      const token = getToken('agent-id', 'agent');

      const response = await request(app)
        .put('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/openclaw.json', content: '{}', encoding: 'utf8' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('DELETE /api/v1/openclaw/workspace/files - system config protection', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => null,
        text: async () => '',
      });
    });

    it('should block agent role from deleting system config files', async () => {
      const token = getToken('agent-id', 'agent');

      const response = await request(app)
        .delete('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/openclaw.json' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('GET /api/v1/openclaw/agents', () => {
    beforeEach(() => {
      pool.query.mockResolvedValue({
        rows: [
          { agent_id: 'coo', name: 'Chief Operating Officer' },
          { agent_id: 'cto', name: 'Chief Technology Officer' },
        ],
      });
    });

    it('should return agents from config file', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: JSON.stringify({
            agents: {
              list: [
                {
                  id: 'coo',
                  name: 'COO',
                  identity: { name: 'COO', emoji: '📊' },
                  workspace: '/workspace/coo',
                  default: true,
                },
                {
                  id: 'cto',
                  name: 'CTO',
                  identity: { name: 'CTO', emoji: '💻' },
                  workspace: '/workspace/cto',
                },
              ],
            },
          }),
        }),
        text: async () => 'OK',
      });

      const response = await request(app)
        .get('/api/v1/openclaw/agents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0]).toHaveProperty('id');
      expect(response.body.data[0]).toHaveProperty('name');
      expect(response.body.data[0]).toHaveProperty('workspace');
    });

    it('should return default COO agent when config file is missing', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockRejectedValue({
        status: 404,
        message: 'File not found',
      });

      const response = await request(app)
        .get('/api/v1/openclaw/agents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0].id).toBe('coo');
    });

    it('should enrich agent names from users table', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: JSON.stringify({
            agents: {
              list: [
                {
                  id: 'coo',
                  name: 'COO',
                  identity: { name: 'COO' },
                  workspace: '/workspace/coo',
                },
              ],
            },
          }),
        }),
        text: async () => 'OK',
      });

      pool.query.mockResolvedValue({
        rows: [{ agent_id: 'coo', name: 'Chief Operating Officer' }],
      });

      const response = await request(app)
        .get('/api/v1/openclaw/agents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT agent_id, name FROM users'),
        expect.any(Array),
      );
    });

    it('should handle database errors gracefully when enriching agent names', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: JSON.stringify({
            agents: {
              list: [
                {
                  id: 'coo',
                  name: 'COO',
                  identity: { name: 'COO' },
                  workspace: '/workspace/coo',
                },
              ],
            },
          }),
        }),
        text: async () => 'OK',
      });

      pool.query.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/v1/openclaw/agents')
        .set('Authorization', `Bearer ${token}`);

      // Should still succeed, just without enrichment
      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
    });

    it('should sort agents with default first', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: JSON.stringify({
            agents: {
              list: [
                {
                  id: 'cto',
                  name: 'CTO',
                  identity: { name: 'CTO' },
                  workspace: '/workspace/cto',
                },
                {
                  id: 'coo',
                  name: 'COO',
                  identity: { name: 'COO' },
                  workspace: '/workspace/coo',
                  default: true,
                },
              ],
            },
          }),
        }),
        text: async () => 'OK',
      });

      pool.query.mockResolvedValue({ rows: [] });

      const response = await request(app)
        .get('/api/v1/openclaw/agents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data[0].id).toBe('coo');
      expect(response.body.data[0].isDefault).toBe(true);
    });
  });

  describe('GET /api/v1/openclaw/org-chart', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: JSON.stringify({
            orgChart: {
              nodes: [{ id: 'coo', name: 'COO' }],
              edges: [],
            },
          }),
        }),
        text: async () => 'OK',
      });
    });

    it('should return org chart configuration', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/org-chart')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should handle missing org chart file', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockRejectedValue({
        status: 404,
        message: 'File not found',
      });

      const response = await request(app)
        .get('/api/v1/openclaw/org-chart')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/v1/openclaw/org-chart/agents/:agentId', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockImplementation(async (url, options) => {
        if (options?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: JSON.stringify({
                leadership: [
                  {
                    id: 'coo',
                    title: 'COO',
                    displayName: 'Chief Operating Officer',
                    status: 'active',
                  },
                ],
              }),
            }),
            text: async () => 'OK',
          };
        }
        if (options?.method === 'PUT') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ updated: true }),
            text: async () => 'OK',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: JSON.stringify({
              agents: {
                list: [
                  {
                    id: 'coo',
                    identity: { name: 'COO' },
                  },
                ],
              },
            }),
          }),
          text: async () => 'OK',
        };
      });
    });

    it('should allow admin to update agent', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .put('/api/v1/openclaw/org-chart/agents/coo')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Updated COO',
          displayName: 'Updated Chief Operating Officer',
        });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should require title and displayName', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .put('/api/v1/openclaw/org-chart/agents/coo')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Updated COO',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('displayName');
    });

    it('should deny agent role from updating', async () => {
      const token = getToken('agent-id', 'agent');

      const response = await request(app)
        .put('/api/v1/openclaw/org-chart/agents/coo')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Updated COO',
          displayName: 'Updated Chief Operating Officer',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/openclaw/org-chart/agents', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockImplementation(async (url, options) => {
        if (options?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: JSON.stringify({
                leadership: [],
                agents: { list: [] },
              }),
            }),
            text: async () => 'OK',
          };
        }
        if (options?.method === 'PUT') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ created: true }),
            text: async () => 'OK',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => 'OK',
        };
      });
    });

    it('should allow admin to create agent', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .post('/api/v1/openclaw/org-chart/agents')
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 'new-agent',
          title: 'New Agent',
          displayName: 'New Agent Display Name',
        });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
    });

    it('should require id, title, and displayName', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .post('/api/v1/openclaw/org-chart/agents')
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 'new-agent',
          title: 'New Agent',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('displayName');
    });

    it('should deny agent role from creating', async () => {
      const token = getToken('agent-id', 'agent');

      const response = await request(app)
        .post('/api/v1/openclaw/org-chart/agents')
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 'new-agent',
          title: 'New Agent',
          displayName: 'New Agent Display Name',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/openclaw/sessions/status', () => {
    beforeEach(() => {
      sessionsListAllViaWs.mockResolvedValue([
        { key: 'session-1', status: 'running' },
        { key: 'session-2', status: 'running' },
        { key: 'session-3', status: 'idle' },
        { key: 'session-4', status: 'idle' },
      ]);
    });

    it('should return session status', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/sessions/status')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data).toHaveProperty('active');
      expect(response.body.data).toHaveProperty('running');
      expect(response.body.data).toHaveProperty('idle');
      expect(response.body.data).toHaveProperty('total');
    });
  });

  describe('GET /api/v1/openclaw/sessions', () => {
    beforeEach(() => {
      sessionsListAllViaWs.mockResolvedValue([
        {
          key: 'agent:coo:session-1',
          status: 'running',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);
      gatewayWsRpc.mockImplementation((method) => {
        if (method === 'sessions.usage') {
          return Promise.resolve({ sessions: [] });
        }
        if (method === 'usage.cost') {
          return Promise.resolve({ totalCost: 0 });
        }
        return Promise.resolve({});
      });
    });

    it('should return sessions list', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/sessions')
        .set('Authorization', `Bearer ${token}`)
        .query({ limit: 10, offset: 0 });

      if (response.status !== 200) {
        console.error('Sessions list error:', response.body);
      }
      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should handle pagination parameters', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/sessions')
        .set('Authorization', `Bearer ${token}`)
        .query({ limit: 20, offset: 10 });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/v1/openclaw/sessions/:sessionId/messages', () => {
    beforeEach(() => {
      sessionsHistory.mockResolvedValue({
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
          },
        ],
      });
    });

    it('should return session messages', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/sessions/session-123/messages')
        .set('Authorization', `Bearer ${token}`)
        .query({ key: 'agent:coo:session-123' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should require session key parameter', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/sessions/session-123/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/openclaw/sessions', () => {
    beforeEach(() => {
      gatewayWsRpc.mockResolvedValue({});
    });

    it('should allow admin to delete sessions', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .delete('/api/v1/openclaw/sessions')
        .set('Authorization', `Bearer ${token}`)
        .query({ key: 'agent:coo:session-1' });

      expect(response.status).toBe(204);
      expect(gatewayWsRpc).toHaveBeenCalledWith('sessions.delete', {
        key: 'agent:coo:session-1',
      });
    });

    it('should require session key parameter', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .delete('/api/v1/openclaw/sessions')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('key');
    });

    it('should deny regular users from deleting sessions', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .delete('/api/v1/openclaw/sessions')
        .set('Authorization', `Bearer ${token}`)
        .query({ key: 'agent:coo:session-1' });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/openclaw/cron-jobs', () => {
    beforeEach(() => {
      cronList.mockResolvedValue([
        {
          id: 'job-1',
          schedule: { kind: 'cron', expr: '0 0 * * *' },
          enabled: true,
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: JSON.stringify({
            agents: { list: [] },
          }),
        }),
        text: async () => 'OK',
      });
      gatewayWsRpc.mockResolvedValue({
        sessions: [],
      });
    });

    it('should return cron jobs list', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/cron-jobs')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });
  });

  describe('POST /api/v1/openclaw/cron-jobs', () => {
    beforeEach(() => {
      createCronJob.mockResolvedValue({
        jobId: 'new-job',
        name: 'test-job',
        schedule: '0 0 * * *',
        enabled: true,
      });
    });

    it('should allow admin to create cron jobs', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .post('/api/v1/openclaw/cron-jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'test-job',
          schedule: '0 0 * * *',
          command: 'echo hello',
        });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
      expect(createCronJob).toHaveBeenCalled();
    });

    it('should deny regular users from creating cron jobs', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .post('/api/v1/openclaw/cron-jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'test-job',
          schedule: '0 0 * * *',
          command: 'echo hello',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/openclaw/usage', () => {
    beforeEach(() => {
      pool.query.mockResolvedValue({
        rows: [
          {
            total_cost_usd: 50.0,
            total_tokens_input: 500000,
            total_tokens_output: 500000,
            total_tokens_cache_read: 100000,
            total_tokens_cache_write: 50000,
            session_count: 10,
          },
        ],
      });
    });

    it('should return usage statistics', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/usage')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });
  });

  describe('POST /api/v1/openclaw/usage/reset', () => {
    let hashedPassword;

    beforeAll(async () => {
      hashedPassword = await bcrypt.hash('test-password', 10);
    });

    beforeEach(() => {
      pool.query.mockImplementation((query) => {
        if (query.includes('SELECT password_hash')) {
          return Promise.resolve({
            rows: [
              {
                password_hash: hashedPassword,
              },
            ],
          });
        }
        if (query.includes('SELECT COUNT(*)')) {
          return Promise.resolve({
            rows: [{ total: '100' }],
          });
        }
        if (query.includes('DELETE')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    it('should allow admin to reset usage with password', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .post('/api/v1/openclaw/usage/reset')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'test-password' });

      expect(response.status).toBe(200);
      expect(response.body.data.success).toBe(true);
    });

    it('should require password', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .post('/api/v1/openclaw/usage/reset')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('Password');
    });

    it('should deny regular users from resetting usage', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .post('/api/v1/openclaw/usage/reset')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'test-password' });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/openclaw/config', () => {
    beforeEach(() => {
      gatewayWsRpc.mockResolvedValue({
        raw: JSON.stringify({
          agents: { list: [] },
          settings: {},
        }),
        hash: 'abc123',
      });
    });

    it('should allow owner to get config', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .get('/api/v1/openclaw/config')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data).toHaveProperty('raw');
      expect(response.body.data).toHaveProperty('hash');
    });

    it('should allow admin to get config', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/config')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
    });

    it('should deny regular users from getting config', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/config')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
    });
  });

  describe('PUT /api/v1/openclaw/config', () => {
    beforeEach(() => {
      gatewayWsRpc.mockImplementation((method, _params) => {
        if (method === 'config.get') {
          return Promise.resolve({
            raw: JSON.stringify({ agents: { list: [] } }),
            hash: 'abc123',
          });
        }
        if (method === 'config.apply') {
          return Promise.resolve({
            hash: 'def456',
          });
        }
        return Promise.resolve({});
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ created: true }),
        text: async () => 'Created',
      });
    });

    it('should allow owner to update config', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .put('/api/v1/openclaw/config')
        .set('Authorization', `Bearer ${token}`)
        .send({
          raw: JSON.stringify({ agents: { list: [] } }),
          baseHash: 'abc123',
        });

      expect(response.status).toBe(200);
      expect(response.body.data.applied).toBe(true);
    });

    it('should require raw and baseHash', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .put('/api/v1/openclaw/config')
        .set('Authorization', `Bearer ${token}`)
        .send({
          agents: { list: [] },
        });

      expect(response.status).toBe(400);
    });

    it('should deny regular users from updating config', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .put('/api/v1/openclaw/config')
        .set('Authorization', `Bearer ${token}`)
        .send({
          raw: JSON.stringify({ agents: { list: [] } }),
          baseHash: 'abc123',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('Error handling', () => {
    it('should handle OpenClaw service errors gracefully', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/status')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(503);
    });

    it('should handle network errors', async () => {
      const token = getToken('user-id', 'user');

      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/status')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(503);
    });
  });
});
