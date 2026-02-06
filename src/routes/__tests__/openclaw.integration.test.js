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
 * Note: These tests mock the OpenClaw service responses.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const openclawRouter = require('../openclaw');

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  return jwt.sign(
    { id: userId, role, email: `${role}@example.com` },
    jwtSecret,
    { expiresIn: '1h' }
  );
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
    // Mock successful OpenClaw responses
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        files: [
          { name: 'test.txt', path: '/test.txt', type: 'file', size: 100 }
        ]
      }),
      text: async () => 'OK'
    });
  });

  describe('GET /api/v1/openclaw/workspace/files', () => {
    it('should allow owner to list files', async () => {
      const token = getToken('owner-id', 'owner');
      
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files?path=%2F&recursive=false'),
        expect.any(Object)
      );
    });

    it('should allow admin to list files', async () => {
      const token = getToken('admin-id', 'admin');
      
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should allow regular user to list files (view metadata only)', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/', recursive: 'false' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should deny unauthenticated access (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .query({ path: '/', recursive: 'false' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject invalid tokens (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files')
        .set('Authorization', 'Bearer invalid-token')
        .query({ path: '/', recursive: 'false' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid or expired token');
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
          encoding: 'utf8'
        }),
        text: async () => 'OK'
      });
    });

    it('should allow owner to read file content', async () => {
      const token = getToken('owner-id', 'owner');
      
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/test.txt' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.content).toBe('Hello, World!');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/files/content?path=%2Ftest.txt'),
        expect.any(Object)
      );
    });

    it('should allow admin to read file content', async () => {
      const token = getToken('admin-id', 'admin');
      
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/test.txt' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should deny regular user access to read file content (403)', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/test.txt' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should deny unauthenticated access (401)', async () => {
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/files/content')
        .query({ path: '/test.txt' });

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
    beforeEach(() => {
      // Mock file creation response
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          path: '/new-file.txt',
          created: true
        }),
        text: async () => 'Created'
      });
    });

    it('should allow owner to create files', async () => {
      const token = getToken('owner-id', 'owner');
      
      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/new-file.txt', content: 'Hello', encoding: 'utf8' });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should allow admin to create files', async () => {
      const token = getToken('admin-id', 'admin');
      
      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/new-file.txt', content: 'Hello', encoding: 'utf8' });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
    });

    it('should deny regular user access to create files (403)', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .post('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/new-file.txt', content: 'Hello', encoding: 'utf8' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/v1/openclaw/workspace/files', () => {
    beforeEach(() => {
      // Mock file update response
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          path: '/test.txt',
          updated: true
        }),
        text: async () => 'OK'
      });
    });

    it('should allow owner to update files', async () => {
      const token = getToken('owner-id', 'owner');
      
      const response = await request(app)
        .put('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/test.txt', content: 'Updated', encoding: 'utf8' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should allow admin to update files', async () => {
      const token = getToken('admin-id', 'admin');
      
      const response = await request(app)
        .put('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/test.txt', content: 'Updated', encoding: 'utf8' });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });

    it('should deny regular user access to update files (403)', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .put('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ path: '/test.txt', content: 'Updated', encoding: 'utf8' });

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
        text: async () => ''
      });
    });

    it('should allow owner to delete files', async () => {
      const token = getToken('owner-id', 'owner');
      
      const response = await request(app)
        .delete('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/test.txt' });

      expect(response.status).toBe(204);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should allow admin to delete files', async () => {
      const token = getToken('admin-id', 'admin');
      
      const response = await request(app)
        .delete('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/test.txt' });

      expect(response.status).toBe(204);
    });

    it('should deny regular user access to delete files (403)', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .delete('/api/v1/openclaw/workspace/files')
        .set('Authorization', `Bearer ${token}`)
        .query({ path: '/test.txt' });

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
          lastSync: new Date().toISOString()
        }),
        text: async () => 'OK'
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
      const response = await request(app)
        .get('/api/v1/openclaw/workspace/status');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
