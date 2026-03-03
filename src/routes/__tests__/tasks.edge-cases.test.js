/**
 * Additional tests for src/routes/tasks.js - Edge cases and error conditions
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock dependencies before importing
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  end: jest.fn(),
  connect: jest.fn(),
}));

const pool = require('../../db/pool');
const tasksRouter = require('../tasks');

// Helper to get JWT token for a user
function getToken(userId, role, email = 'test@example.com', name = 'Test User') {
  const jwtSecret = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production';
  return jwt.sign({ id: userId, role, email, name }, jwtSecret, {
    expiresIn: '1h',
  });
}

// Existing task fixture for update route tests
const existingTask = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Existing Task',
  status: 'PLANNING',
  priority: 'Medium',
  type: 'task',
  tags: [],
  parent_task_id: null,
  preferred_model: null,
};

describe('Tasks Route Edge Cases', () => {
  let app;
  let mockClient;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(mockClient);
  });

  describe('Validation Middleware', () => {
    it('should return 400 for invalid UUID format in task ID parameter', async () => {
      const token = getToken('user-123', 'user');

      const response = await request(app)
        .get('/api/v1/tasks/invalid-uuid')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid UUID format');
    });

    it('should return 400 for invalid task key format', async () => {
      const token = getToken('user-123', 'user');

      const response = await request(app)
        .get('/api/v1/tasks/key/invalid-key-format')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid task key format. Expected TASK-{number}');
    });

    it('should accept valid task key format', async () => {
      const token = getToken('user-123', 'user');
      pool.query.mockResolvedValueOnce({ rows: [] }); // Mock empty results

      const response = await request(app)
        .get('/api/v1/tasks/keys/TASK-1234')
        .set('Authorization', `Bearer ${token}`);

      // Should not return 400 validation error (could be 404 or 200 depending on business logic)
      expect(response.status).not.toBe(400);
    });
  });

  describe('Task Creation Edge Cases', () => {
    it('should return 400 when creating task with invalid status', async () => {
      const token = getToken('user-123', 'user');

      const response = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Test Task',
          status: 'invalid_status', // This should trigger validation
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid status');
    });

    it('should return 400 when creating task with invalid priority', async () => {
      const token = getToken('user-123', 'user');

      const response = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Test Task',
          priority: 'invalid_priority', // This should trigger validation
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid priority');
    });

    it('should return 400 when creating task with invalid type', async () => {
      const token = getToken('user-123', 'user');

      const response = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Test Task',
          status: 'TO DO',
          priority: 'Medium',
          type: 'invalid_type', // This should trigger validation
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid type');
    });

    it('should return 400 when creating task with a tag exceeding max length', async () => {
      const token = getToken('user-123', 'user');

      const response = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Test Task',
          status: 'TO DO',
          priority: 'Medium',
          type: 'feature',
          tags: ['a'.repeat(51)], // Tag exceeds 50 character limit
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Each tag must be 50 characters or less');
    });

    it('should return 400 when creating task with invalid parent ID format', async () => {
      const token = getToken('user-123', 'user');
      pool.query.mockResolvedValueOnce({ rows: [] }); // Mock parent check returning no results

      const response = await request(app)
        .post('/api/v1/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Test Task',
          status: 'TO DO',
          priority: 'Medium',
          type: 'feature',
          parent_task_id: 'invalid-uuid-format', // Invalid UUID - parent not found
        });

      // POST route checks parent existence via pool.query - mock returns no rows → parent not found
      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Parent task not found');
    });
  });

  describe('Task Update Edge Cases', () => {
    // Each PATCH test goes through the PUT handler: BEGIN → SELECT task → validation → ROLLBACK
    function setupUpdateMocks() {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [existingTask] }) // SELECT existing task
        .mockResolvedValueOnce({}); // ROLLBACK
    }

    it('should return 400 when updating task with no fields', async () => {
      const token = getToken('user-123', 'user');
      setupUpdateMocks();

      const response = await request(app)
        .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('No fields to update');
    });

    it('should return 400 when updating task with invalid status', async () => {
      const token = getToken('user-123', 'user');
      setupUpdateMocks();

      const response = await request(app)
        .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: 'invalid_status',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid status');
    });

    it('should return 400 when updating task with invalid priority', async () => {
      const token = getToken('user-123', 'user');
      setupUpdateMocks();

      const response = await request(app)
        .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
        .set('Authorization', `Bearer ${token}`)
        .send({
          priority: 'invalid_priority',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid priority');
    });

    it('should return 400 when updating task with invalid type', async () => {
      const token = getToken('user-123', 'user');
      setupUpdateMocks();

      const response = await request(app)
        .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'invalid_type',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid type');
    });
  });

  describe('Task Dependencies Edge Cases', () => {
    it('should return 401 when creating dependency without authorization', async () => {
      const response = await request(app)
        .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/dependencies')
        .send({
          dependency_task_id: '22222222-2222-2222-2222-222222222222',
          dependency_type: 'blocking',
        });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should return 409 when creating duplicate dependency', async () => {
      const token = getToken('user-123', 'user');
      // Route uses client.query: BEGIN, task existence check, circular check, duplicate check
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            { id: '11111111-1111-1111-1111-111111111111' },
            { id: '22222222-2222-2222-2222-222222222222' },
          ],
        }) // both tasks exist
        .mockResolvedValueOnce({ rows: [{ has_circular: false }] }) // no circular dependency
        .mockResolvedValueOnce({ rows: [{ id: 'existing-dep' }] }) // dependency already exists
        .mockResolvedValueOnce({}); // ROLLBACK

      const response = await request(app)
        .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/dependencies')
        .set('Authorization', `Bearer ${token}`)
        .send({
          depends_on_task_id: '22222222-2222-2222-2222-222222222222',
        });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toBe('Dependency already exists');
    });

    it('should return 401 when deleting dependency without authorization', async () => {
      const response = await request(app).delete(
        '/api/v1/tasks/11111111-1111-1111-1111-111111111111/dependencies/22222222-2222-2222-2222-222222222222',
      );

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });
  });

  describe('Task Comments Edge Cases', () => {
    it('should return 401 when creating comment without authorization', async () => {
      const response = await request(app)
        .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments')
        .send({
          body: 'Test comment',
        });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should return 400 when creating comment with empty body', async () => {
      const token = getToken('user-123', 'user');

      const response = await request(app)
        .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          body: '', // Empty body
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Comment body is required');
    });

    it('should return 401 when updating comment without authorization', async () => {
      const response = await request(app)
        .patch(
          '/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments/22222222-2222-2222-2222-222222222222',
        )
        .send({
          body: 'Updated comment',
        });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should return 401 when deleting comment without authorization', async () => {
      const response = await request(app).delete(
        '/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments/22222222-2222-2222-2222-222222222222',
      );

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });
  });

  describe('Task Preferred Model Edge Cases', () => {
    // preferred_model is set via PATCH /:id with preferred_model in the body
    it('should return 400 when updating task with empty preferred_model', async () => {
      const token = getToken('user-123', 'user');
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [existingTask] }) // SELECT existing task
        .mockResolvedValueOnce({}); // ROLLBACK

      const response = await request(app)
        .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
        .set('Authorization', `Bearer ${token}`)
        .send({ preferred_model: '' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('preferred_model must be a non-empty string');
    });

    it('should return 400 when updating task with preferred_model exceeding max length', async () => {
      const token = getToken('user-123', 'user');
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [existingTask] }) // SELECT existing task
        .mockResolvedValueOnce({}); // ROLLBACK

      const response = await request(app)
        .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
        .set('Authorization', `Bearer ${token}`)
        .send({ preferred_model: 'a'.repeat(201) });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('preferred_model must be 200 characters or less');
    });
  });
});
