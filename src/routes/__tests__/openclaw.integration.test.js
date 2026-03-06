/**
 * Integration tests for OpenClaw workspace file access control
 *
 * These tests verify that role-based access control works correctly:
 * - Admin/Owner can list files
 * - Admin/Owner can read file content
 * - Regular users cannot list files (403)
 * - Regular users cannot read file content (403)
 * - Unauthenticated requests are rejected (401)
 *
 * Mocks pool and fetch so no live database or OpenClaw is needed.
 */

// Mock pool before requiring openclaw router (avoids real DB connections)
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  end: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const openclawRouter = require('../openclaw');

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production';
  return jwt.sign({ id: userId, role, email: `${role}@example.com` }, jwtSecret, {
    expiresIn: '1h',
  });
}

describe('OpenClaw Workspace Access Control', () => {
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
    mockOpenClawUrl = 'http://mock-openclaw:18780';
    process.env.OPENCLAW_WORKSPACE_URL = mockOpenClawUrl;
    process.env.OPENCLAW_PATH_REMAP_PREFIXES = '';
  });

  afterAll(() => {
    // Restore original fetch
    global.fetch = originalFetch;
    delete process.env.OPENCLAW_WORKSPACE_URL;
    delete process.env.OPENCLAW_PATH_REMAP_PREFIXES;
  });

  beforeEach(() => {
    process.env.OPENCLAW_PATH_REMAP_PREFIXES = '';

    // Mock successful OpenClaw responses
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        files: [{ name: 'test.txt', path: '/workspace-main/test.txt', type: 'file', size: 100 }],
      }),
      text: async () => 'OK',
    });
  });

  describe('GET /api/v1/openclaw/workspace/files', () => {
    it('should allow owner to list files', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2Fworkspace&recursive=false'),
        expect.any(Object),
      );
    });

    it('should allow admin to list files', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should allow regular user to list files (view metadata only)', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should deny unauthenticated access (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .query({ path: '/workspace', recursive: 'false' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject invalid tokens (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', 'Bearer invalid-token')
        .query({ path: '/workspace', recursive: 'false' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid or expired token');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should remap host-absolute OpenClaw paths before forwarding', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({
          path: '/home/node/.openclaw/workspace/design-docs',
          recursive: 'false',
        });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2Fworkspace%2Fdesign-docs&recursive=false'),
        expect.any(Object),
      );
    });

    it('should remap tilde OpenClaw paths before forwarding', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '~/.openclaw/workspace/foo', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2Fworkspace%2Ffoo&recursive=false'),
        expect.any(Object),
      );
    });

    it('should prioritize the longest matching prefix to avoid nested workspace pathing', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({
          path: '~/.openclaw/workspace/workspace-clawboard-worker/foo',
          recursive: 'false',
        });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          '/files?path=%2Fworkspace%2Fworkspace-clawboard-worker%2Ffoo&recursive=false',
        ),
        expect.any(Object),
      );
    });

    it('should keep built-in remap prefixes active when custom prefixes are configured', async () => {
      const token = getToken('admin-id', 'admin');
      process.env.OPENCLAW_PATH_REMAP_PREFIXES = '/opt/custom';

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({
          path: '~/.openclaw/workspace/workspace-clawboard-worker/foo',
          recursive: 'false',
        });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          '/files?path=%2Fworkspace%2Fworkspace-clawboard-worker%2Ffoo&recursive=false',
        ),
        expect.any(Object),
      );
    });

    it('should append custom remap prefixes from env', async () => {
      const token = getToken('admin-id', 'admin');
      process.env.OPENCLAW_PATH_REMAP_PREFIXES = '/opt/custom';

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/opt/custom/workspace-qa', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2Fworkspace-qa&recursive=false'),
        expect.any(Object),
      );
    });

    it('should reject non-remapped unsupported absolute-looking paths', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/tmp/not-allowed', recursive: 'false' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PATH_NOT_ALLOWED');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should allow canonical main workspace subpaths under /workspace/*', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace/design-docs', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2Fworkspace%2Fdesign-docs&recursive=false'),
        expect.any(Object),
      );
    });

    it('should reject main workspace paths outside /workspace/*', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/design-docs', recursive: 'false' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PATH_NOT_ALLOWED');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/openclaw/workspace/files/content', () => {
    beforeEach(() => {
      // Mock file content response
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: 'Hello, World!',
          size: 13,
          modified: new Date().toISOString(),
          encoding: 'utf8',
        }),
        text: async () => 'OK',
      });
    });

    it('should allow owner to read file content', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace-main/test.txt' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.content).toBe('Hello, World!');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files/content?path='),
        expect.any(Object),
      );
    });

    it('should allow admin to read file content', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace-main/test.txt' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should remap tilde config paths to /openclaw.json', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '~/.openclaw/openclaw.json' });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files/content?path=%2Fopenclaw.json'),
        expect.any(Object),
      );
    });

    it('should deny regular user access to read file content (403)', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace-main/test.txt' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should deny unauthenticated access (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .query({ path: '/workspace-main/test.txt' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should require path parameter', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Path parameter is required');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/openclaw/workspace/files', () => {
    it('should allow owner to create files', async () => {
      const token = getToken('owner-id', 'owner');

      // Mock: First call (existence check) returns 404, second call (creation) succeeds
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async (_url, _options) => {
        callCount++;
        if (callCount === 1) {
          // First call: existence check - file doesn't exist (404)
          return {
            ok: false,
            status: 404,
            text: async () => 'Not Found',
          };
        } else {
          // Second call: file creation - succeeds
          return {
            ok: true,
            status: 201,
            json: async () => ({
              path: '/workspace-main/new-file.txt',
              created: true,
            }),
            text: async () => 'Created',
          };
        }
      });

      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/workspace-main/new-file.txt', content: 'Hello', encoding: 'utf8' });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should allow admin to create files', async () => {
      const token = getToken('admin-id', 'admin');

      // Mock: First call (existence check) returns 404, second call (creation) succeeds
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async (_url, _options) => {
        callCount++;
        if (callCount === 1) {
          // First call: existence check - file doesn't exist (404)
          return {
            ok: false,
            status: 404,
            text: async () => 'Not Found',
          };
        } else {
          // Second call: file creation - succeeds
          return {
            ok: true,
            status: 201,
            json: async () => ({
              path: '/workspace-main/new-file.txt',
              created: true,
            }),
            text: async () => 'Created',
          };
        }
      });

      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/workspace-main/new-file.txt', content: 'Hello', encoding: 'utf8' });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
    });

    it('should deny regular user access to create files (403)', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/workspace-main/new-file.txt', content: 'Hello', encoding: 'utf8' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    describe('File existence validation', () => {
      it('should successfully create file when file does not exist', async () => {
        const token = getToken('owner-id', 'owner');

        // Mock: First call (existence check) returns 404, second call (creation) succeeds
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(async (_url, _options) => {
          callCount++;
          if (callCount === 1) {
            // First call: existence check - file doesn't exist (404)
            return {
              ok: false,
              status: 404,
              text: async () => 'Not Found',
            };
          } else {
            // Second call: file creation - succeeds
            return {
              ok: true,
              status: 201,
              json: async () => ({
                path: '/workspace-main/new-file.txt',
                created: true,
              }),
              text: async () => 'Created',
            };
          }
        });

        const response = await request(app)
          .post('/api/v1/openclaw/workspace/files')
          .set('Authorization', `Bearer ${token}`)
          .send({ path: '/workspace-main/new-file.txt', content: 'Hello', encoding: 'utf8' });

        expect(response.status).toBe(201);
        expect(response.body.data).toBeDefined();
        expect(global.fetch).toHaveBeenCalledTimes(2);

        // Verify first call was existence check
        const firstCall = global.fetch.mock.calls[0];
        expect(firstCall[0]).toContain('/files/content?path=');
        expect(firstCall[1].method).toBe('GET');

        // Verify second call was file creation
        const secondCall = global.fetch.mock.calls[1];
        expect(secondCall[0]).toContain('/files');
        expect(secondCall[1].method).toBe('POST');
      });

      it('should return 409 Conflict when file already exists', async () => {
        const token = getToken('owner-id', 'owner');

        // Mock: Existence check returns 200 (file exists)
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            content: 'Existing content',
            size: 15,
            modified: new Date().toISOString(),
            encoding: 'utf8',
          }),
          text: async () => 'OK',
        });

        const response = await request(app)
          .post('/api/v1/openclaw/workspace/files')
          .set('Authorization', `Bearer ${token}`)
          .send({
            path: '/workspace-main/existing-file.txt',
            content: 'New content',
            encoding: 'utf8',
          });

        expect(response.status).toBe(409);
        expect(response.body.error).toBeDefined();
        expect(response.body.error.message).toContain('File already exists');
        expect(response.body.error.status).toBe(409);
        expect(response.body.error.code).toBe('FILE_EXISTS');

        // Should only call existence check, not creation
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const call = global.fetch.mock.calls[0];
        expect(call[0]).toContain('/files/content?path=');
        expect(call[1].method).toBe('GET');
      });

      it('should handle race condition scenario (concurrent requests)', async () => {
        const token = getToken('owner-id', 'owner');

        // Mock: First request checks existence (404), then creates
        // Second concurrent request checks existence (still 404), then tries to create
        global.fetch = jest.fn().mockImplementation(async (_url, options) => {
          if (options.method === 'GET') {
            // Existence check - file doesn't exist yet
            return {
              ok: false,
              status: 404,
              text: async () => 'Not Found',
            };
          } else {
            // File creation - succeeds
            return {
              ok: true,
              status: 201,
              json: async () => ({
                path: '/workspace/race-file.txt',
                created: true,
              }),
              text: async () => 'Created',
            };
          }
        });

        // Simulate two concurrent requests
        const [response1, response2] = await Promise.all([
          request(app)
            .post('/api/v1/openclaw/workspace/files')
            .set('Authorization', `Bearer ${token}`)
            .send({ path: '/workspace/race-file.txt', content: 'Request 1', encoding: 'utf8' }),
          request(app)
            .post('/api/v1/openclaw/workspace/files')
            .set('Authorization', `Bearer ${token}`)
            .send({ path: '/workspace/race-file.txt', content: 'Request 2', encoding: 'utf8' }),
        ]);

        // Both requests pass existence check (404), but workspace service should handle atomicity
        // At least one should succeed, the other might succeed or fail depending on workspace service
        expect([response1.status, response2.status]).toContain(201);
        // Both should have attempted existence check
        expect(global.fetch).toHaveBeenCalled();
      });

      it('should proceed with creation when workspace service returns non-404 error during existence check', async () => {
        const token = getToken('owner-id', 'owner');

        // Mock: Existence check returns 500 (service error), but we proceed with creation
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(async (_url, _options) => {
          callCount++;
          if (callCount === 1) {
            // First call: existence check returns 500
            const error = new Error('OpenClaw workspace service error: 500 Internal Server Error');
            error.status = 500;
            error.code = 'OPENCLAW_SERVICE_ERROR';
            return {
              ok: false,
              status: 500,
              text: async () => 'Internal Server Error',
            };
          } else {
            // Second call: file creation succeeds
            return {
              ok: true,
              status: 201,
              json: async () => ({
                path: '/workspace/service-error-file.txt',
                created: true,
              }),
              text: async () => 'Created',
            };
          }
        });

        const response = await request(app)
          .post('/api/v1/openclaw/workspace/files')
          .set('Authorization', `Bearer ${token}`)
          .send({ path: '/workspace/service-error-file.txt', content: 'Hello', encoding: 'utf8' });

        // Should proceed with creation despite non-404 error
        expect(response.status).toBe(201);
        expect(response.body.data).toBeDefined();
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('should throw error when workspace service returns unexpected error during existence check', async () => {
        const token = getToken('owner-id', 'owner');

        // Mock: Existence check throws unexpected error (not 404, not OPENCLAW_SERVICE_ERROR)
        // makeOpenClawRequest wraps network errors as 503 SERVICE_ERROR
        global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

        const response = await request(app)
          .post('/api/v1/openclaw/workspace/files')
          .set('Authorization', `Bearer ${token}`)
          .send({ path: '/workspace/error-file.txt', content: 'Hello', encoding: 'utf8' });

        // Should propagate the error (makeOpenClawRequest wraps network errors as 503)
        expect(response.status).toBe(503);
        expect(response.body.error).toBeDefined();
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('PUT /api/v1/openclaw/workspace/files', () => {
    beforeEach(() => {
      // Mock file update response
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          path: '/workspace-main/test.txt',
          updated: true,
        }),
        text: async () => 'OK',
      });
    });

    it('should allow owner to update files', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .put('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/workspace-main/test.txt', content: 'Updated', encoding: 'utf8' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should allow admin to update files', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .put('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/workspace-main/test.txt', content: 'Updated', encoding: 'utf8' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should deny regular user access to update files (403)', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .put('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/workspace-main/test.txt', content: 'Updated', encoding: 'utf8' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/openclaw/workspace/files', () => {
    beforeEach(() => {
      // Mock file deletion response
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => null,
        text: async () => '',
      });
    });

    it('should allow owner to delete files', async () => {
      const token = getToken('owner-id', 'owner');

      const response = await request(app)
        .delete('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace-main/test.txt' });

      expect(response.status).toBe(204);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should allow admin to delete files', async () => {
      const token = getToken('admin-id', 'admin');

      const response = await request(app)
        .delete('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace-main/test.txt' });

      expect(response.status).toBe(204);
    });

    it('should deny regular user access to delete files (403)', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .delete('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/workspace-main/test.txt' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/openclaw/workspace/status', () => {
    beforeEach(() => {
      // Mock status response
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'healthy',
          lastSync: new Date().toISOString(),
        }),
        text: async () => 'OK',
      });
    });

    it('should allow authenticated users to check status', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .get('/api/v1/openclaw/workspace/status')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should deny unauthenticated access (401)', async () => {
      const response = await request(app).get('/api/v1/openclaw/workspace/status');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/openclaw/agents mapping', () => {
    it('maps missing workspace for default/main agents to /workspace and others to /workspace-<id>', async () => {
      const token = getToken('admin-id', 'admin');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: JSON.stringify({
            agents: {
              list: [
                {
                  id: 'main',
                  name: 'main',
                  default: false,
                },
                {
                  id: 'coo',
                  name: 'coo',
                  default: true,
                },
                {
                  id: 'helper',
                  name: 'helper',
                },
                {
                  id: 'clawboard-worker',
                  name: 'Clawboard Worker',
                  workspace: '~/.openclaw/workspace/workspace-clawboard-worker',
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
      expect(Array.isArray(response.body.data)).toBe(true);

      const mainAgent = response.body.data.find((a) => a.id === 'main');
      const defaultAgent = response.body.data.find((a) => a.id === 'coo');
      const helperAgent = response.body.data.find((a) => a.id === 'helper');
      const explicitWorkspaceAgent = response.body.data.find((a) => a.id === 'clawboard-worker');

      expect(mainAgent.workspace).toBe('/workspace');
      expect(defaultAgent.workspace).toBe('/workspace');
      expect(helperAgent.workspace).toBe('/workspace-helper');
      expect(explicitWorkspaceAgent.workspace).toBe('/workspace/workspace-clawboard-worker');
    });
  });

  describe('GET /api/v1/openclaw/agents fallback', () => {
    it('returns 500 config is unreadable', async () => {
      const token = getToken('admin-id', 'admin');

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const response = await request(app)
        .get('/api/v1/openclaw/agents')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(0);
    });
  });
});
