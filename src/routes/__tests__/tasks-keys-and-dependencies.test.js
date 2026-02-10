/**
 * Unit tests for task keys and dependencies endpoints
 *
 * These tests mock the DB pool and validate:
 * - Task key lookup endpoint
 * - Dependency management endpoints
 * - Circular dependency detection
 * - Blocking logic for status changes
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

describe('Task Keys and Dependencies (Unit Tests)', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/tasks/key/:key', () => {
    it('should return 400 for invalid task key format', async () => {
      const response = await request(app).get('/api/v1/tasks/key/invalid-key');

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('Invalid task key format');
    });

    it('should return 404 if task with key does not exist', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app).get('/api/v1/tasks/key/TASK-1234');

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Task not found');
    });

    it('should return task when found by key', async () => {
      const mockTask = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_number: 1234,
        title: 'Test Task',
        status: 'TODO',
        type: 'task'
      };

      pool.query.mockResolvedValueOnce({ rows: [mockTask] });

      const response = await request(app).get('/api/v1/tasks/key/TASK-1234');

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.task_number).toBe(1234);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE t.task_number = $1'),
        [1234]
      );
    });

    it('should parse task number correctly with radix 10', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await request(app).get('/api/v1/tasks/key/TASK-1234');

      // Verify parseInt was called with radix 10 (implicitly verified by correct parsing)
      expect(pool.query).toHaveBeenCalledWith(
        expect.any(String),
        [1234] // Should be parsed as base-10, not octal
      );
    });
  });

  describe('GET /api/v1/tasks/:id/dependencies', () => {
    it('should return 404 if task does not exist', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies'
      );

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Task not found');
    });

    it('should return empty arrays when task has no dependencies', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }] }) // task exists
        .mockResolvedValueOnce({ rows: [] }) // dependencies (depends_on)
        .mockResolvedValueOnce({ rows: [] }); // dependencies (dependents)

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies'
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data.depends_on)).toBe(true);
      expect(Array.isArray(response.body.data.dependents)).toBe(true);
      expect(response.body.data.depends_on.length).toBe(0);
      expect(response.body.data.dependents.length).toBe(0);
    });

    it('should return dependencies when task has them', async () => {
      const mockDependency = {
        id: '550e8400-e29b-41d4-a716-446655440001',
        task_number: 1235,
        title: 'Dependency Task',
        status: 'TODO'
      };

      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }] }) // task exists
        .mockResolvedValueOnce({ rows: [mockDependency] }) // dependencies (depends_on)
        .mockResolvedValueOnce({ rows: [] }); // dependencies (dependents)

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies'
      );

      expect(response.status).toBe(200);
      expect(response.body.data.depends_on.length).toBe(1);
      expect(response.body.data.depends_on[0].id).toBe(mockDependency.id);
    });
  });

  describe('POST /api/v1/tasks/:id/dependencies', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies')
        .send({ depends_on_task_id: '550e8400-e29b-41d4-a716-446655440001' });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should return 400 for self-dependency', async () => {
      const token = getToken('user-id', 'user');

      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies')
        .set('Authorization', `Bearer ${token}`)
        .send({ depends_on_task_id: '550e8400-e29b-41d4-a716-446655440000' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Task cannot depend on itself');
    });

    it('should return 404 if task does not exist', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }] }); // task check (only 1 task found, not 2)

      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies')
        .set('Authorization', `Bearer ${token}`)
        .send({ depends_on_task_id: '550e8400-e29b-41d4-a716-446655440001' });

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('One or both tasks not found');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should return 400 for circular dependency', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }, { id: 'depends-on-id' }] }) // task check (both exist)
        .mockResolvedValueOnce({ rows: [{ has_circular: true }] }); // circular check

      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies')
        .set('Authorization', `Bearer ${token}`)
        .send({ depends_on_task_id: '550e8400-e29b-41d4-a716-446655440001' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Cannot add dependency: would create a circular dependency');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should return 409 if dependency already exists', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }, { id: 'depends-on-id' }] }) // task check
        .mockResolvedValueOnce({ rows: [{ has_circular: false }] }) // circular check
        .mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // existing dependency check

      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies')
        .set('Authorization', `Bearer ${token}`)
        .send({ depends_on_task_id: '550e8400-e29b-41d4-a716-446655440001' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toBe('Dependency already exists');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should create dependency when valid', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }, { id: 'depends-on-id' }] }) // task check
        .mockResolvedValueOnce({ rows: [{ has_circular: false }] }) // circular check
        .mockResolvedValueOnce({ rows: [] }) // existing dependency check (none)
        .mockResolvedValueOnce({ rows: [{ id: 'dep-id' }] }) // insert dependency
        .mockResolvedValueOnce({ rows: [{ id: 'dep-id', task_id: 'task-id', depends_on_task_id: 'depends-on-id' }] }) // fetch dependency
        .mockResolvedValueOnce({}) // log
        .mockResolvedValueOnce({}); // COMMIT

      const response = await request(app)
        .post('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies')
        .set('Authorization', `Bearer ${token}`)
        .send({ depends_on_task_id: '550e8400-e29b-41d4-a716-446655440001' });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/tasks/:id/dependencies/:dependsOnId', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies/550e8400-e29b-41d4-a716-446655440001');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Authorization required');
    });

    it('should return 404 if dependency does not exist', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // DELETE returns no rows

      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Dependency not found');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should delete dependency when valid', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'dep-id' }], rowCount: 1 }) // DELETE returns row
        .mockResolvedValueOnce({}); // COMMIT

      const response = await request(app)
        .delete('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/dependencies/550e8400-e29b-41d4-a716-446655440001')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(204);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/tasks/:id/subtasks', () => {
    it('should return 404 if task does not exist', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/subtasks'
      );

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Task not found');
    });

    it('should return empty array when task has no subtasks', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }] }) // task exists
        .mockResolvedValueOnce({ rows: [] }); // subtasks query

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/subtasks'
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(0);
    });

    it('should return subtasks when task has them', async () => {
      const mockSubtasks = [
        { id: '550e8400-e29b-41d4-a716-446655440001', task_number: 1235, title: 'Subtask 1', parent_sort_order: 1 },
        { id: '550e8400-e29b-41d4-a716-446655440002', task_number: 1236, title: 'Subtask 2', parent_sort_order: 2 }
      ];

      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-id' }] }) // task exists
        .mockResolvedValueOnce({ rows: mockSubtasks }); // subtasks query

      const response = await request(app).get(
        '/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/subtasks'
      );

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      expect(response.body.data[0].id).toBe(mockSubtasks[0].id);
      expect(response.body.data[1].id).toBe(mockSubtasks[1].id);
    });
  });

  describe('Status change blocking logic', () => {
    it('should block status change to IN_PROGRESS when dependencies are incomplete', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      const incompleteDependency = {
        task_number: 1235,
        title: 'Incomplete Dependency',
        status: 'TODO'
      };

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'task-id', status: 'TODO' }] }) // fetch existing task
        .mockResolvedValueOnce({ rows: [incompleteDependency] }) // check blocking dependencies
        .mockResolvedValueOnce({}); // ROLLBACK

      // pool.query is used to log the blocking event after rollback
      pool.query.mockResolvedValueOnce({});

      const response = await request(app)
        .patch('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'IN PROGRESS' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('Cannot move to');
      expect(response.body.error.message).toContain('blocked by');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should allow status change when all dependencies are complete', async () => {
      const token = getToken('user-id', 'user');

      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'task-id', status: 'TODO' }] }) // fetch existing task
        .mockResolvedValueOnce({ rows: [] }) // check blocking dependencies (none incomplete)
        .mockResolvedValueOnce({ rows: [{ id: 'task-id', status: 'IN PROGRESS' }] }) // UPDATE ... RETURNING *
        .mockResolvedValueOnce({}) // logTaskEvent INSERT
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({ rows: [{ id: 'task-id', status: 'IN PROGRESS' }] }); // fetch complete task with joins

      const response = await request(app)
        .patch('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'IN PROGRESS' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('IN PROGRESS');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
