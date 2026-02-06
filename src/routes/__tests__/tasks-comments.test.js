/**
 * Unit tests for task comments endpoints
 *
 * These tests mock the DB pool and validate:
 * - auth requirement for creating comments
 * - validation of comment body
 * - happy path for listing and creating comments
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const pool = require('../../db/pool');
const tasksRouter = require('../tasks');

function getToken(userId, role = 'user') {
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  return jwt.sign({ id: userId, role, email: `${role}@example.com` }, jwtSecret, { expiresIn: '1h' });
}

describe('Task Comments (Unit Tests)', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/tasks/:id/comments', () => {
    it('should return 404 if task does not exist', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // task exists check

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments'
      );

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Task not found');
    });

    it('should list comments when task exists', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }] }) // task exists check
        .mockResolvedValueOnce({ rows: [{ id: 'comment-1', body: 'Hello' }], rowCount: 1 }); // comments query

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments?limit=50&offset=0'
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data[0].body).toBe('Hello');
    });
  });

  describe('POST /api/v1/tasks/:id/comments', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments')
        .send({ body: 'Hi' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should validate body', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments')
        .set('Authorization', `Bearer ${token}`)
        .send({ body: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Comment body is required');
    });

    it('should create a comment when authorized and task exists', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }] }) // task exists
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', task_id: 'task-id', body: 'Hello' }] }) // insert
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', body: 'Hello', author_name: 'User' }] }) // join fetch
        .mockResolvedValueOnce({}); // COMMIT

      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments')
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Hello' });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.body).toBe('Hello');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/v1/tasks/:taskId/comments/:commentId', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .patch('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .send({ body: 'Updated' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should return 404 if comment does not exist', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // comment fetch

      const response = await request(app)
        .patch('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Updated' });

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Comment not found');
    });

    it('should deny non-author non-admin from editing', async () => {
      const token = getToken('other-user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', author_id: 'original-author-id', body: 'Old' }] }); // comment fetch

      const response = await request(app)
        .patch('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Updated' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain('Only the comment author or an admin');
    });

    it('should allow author to edit their comment', async () => {
      const token = getToken('author-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', author_id: 'author-id', body: 'Old' }] }) // fetch existing
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', body: 'Updated' }] }) // update
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', body: 'Updated', author_name: 'Author' }] }) // join fetch
        .mockResolvedValueOnce({}) // log
        .mockResolvedValueOnce({}); // COMMIT

      const response = await request(app)
        .patch('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Updated' });

      expect(response.status).toBe(200);
      expect(response.body.data.body).toBe('Updated');
    });

    it('should allow admin to edit any comment', async () => {
      const token = getToken('admin-id', 'admin');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', author_id: 'other-user', body: 'Old' }] }) // fetch existing
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', body: 'Admin edit' }] }) // update
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', body: 'Admin edit', author_name: 'Other' }] }) // join fetch
        .mockResolvedValueOnce({}) // log
        .mockResolvedValueOnce({}); // COMMIT

      const response = await request(app)
        .patch('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Admin edit' });

      expect(response.status).toBe(200);
      expect(response.body.data.body).toBe('Admin edit');
    });
  });

  describe('DELETE /api/v1/tasks/:taskId/comments/:commentId', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should return 404 if comment does not exist', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // comment fetch

      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Comment not found');
    });

    it('should deny non-author non-admin from deleting', async () => {
      const token = getToken('other-user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', author_id: 'original-author-id', body: 'Old' }] }); // comment fetch

      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain('Only the comment author or an admin');
    });

    it('should allow author to delete their comment', async () => {
      const token = getToken('author-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', author_id: 'author-id', body: 'Old' }] }) // fetch existing
        .mockResolvedValueOnce({}) // log
        .mockResolvedValueOnce({}) // delete
        .mockResolvedValueOnce({}); // COMMIT

      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(204);
    });

    it('should allow owner to delete any comment', async () => {
      const token = getToken('owner-id', 'owner');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'comment-id', author_id: 'other-user', body: 'Old' }] }) // fetch existing
        .mockResolvedValueOnce({}) // log
        .mockResolvedValueOnce({}) // delete
        .mockResolvedValueOnce({}); // COMMIT

      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/comments/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(204);
    });
  });
});

