/**
 * Unit tests for preferred_model in task create/update
 *
 * Tests that:
 * - POST accepts preferred_model and persists it
 * - POST rejects empty preferred_model string
 * - POST rejects preferred_model over 200 chars
 * - PUT accepts preferred_model and updates it
 * - PUT rejects invalid preferred_model
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require('../../db/pool');
const tasksRouter = require('../tasks');

describe('Task preferred_model (Unit Tests)', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/tasks with preferred_model', () => {
    it('should create task with preferred_model and return it', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      pool.connect.mockResolvedValue(mockClient);
      pool.query.mockResolvedValue({ rows: [] }); // parent_task_id check when not provided

      const newTaskWithPreferredModel = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test Task',
        summary: null,
        description: null,
        status: 'PLANNING',
        priority: null,
        type: 'task',
        reporter_id: null,
        assignee_id: null,
        due_date: null,
        done_at: null,
        archived_at: null,
        tags: null,
        parent_task_id: null,
        preferred_model: 'openrouter/anthropic/claude-sonnet-4.5',
      };

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [newTaskWithPreferredModel],
        }) // INSERT RETURNING
        .mockResolvedValueOnce({}) // INSERT task_logs (logTaskEvent)
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({
          rows: [{ ...newTaskWithPreferredModel, reporter_name: null, assignee_name: null }],
        }); // SELECT complete task

      const response = await request(app).post('/api/v1/tasks').send({
        title: 'Test Task',
        preferred_model: 'openrouter/anthropic/claude-sonnet-4.5',
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.preferred_model).toBe('openrouter/anthropic/claude-sonnet-4.5');

      const insertCall = mockClient.query.mock.calls.find((c) =>
        c[0].includes('INSERT INTO tasks'),
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall[1];
      expect(insertParams[insertParams.length - 1]).toBe('openrouter/anthropic/claude-sonnet-4.5');
    });

    it('should reject preferred_model when empty string', async () => {
      const response = await request(app).post('/api/v1/tasks').send({
        title: 'Test Task',
        preferred_model: '   ',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('preferred_model must be a non-empty string');
    });

    it('should reject preferred_model over 200 characters', async () => {
      const longModel = 'a'.repeat(201);

      const response = await request(app).post('/api/v1/tasks').send({
        title: 'Test Task',
        preferred_model: longModel,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('preferred_model must be 200 characters or less');
    });

    it('should create task with preferred_model null when omitted', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      pool.connect.mockResolvedValue(mockClient);

      const newTask = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test Task',
        preferred_model: null,
      };

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [newTask] }) // INSERT RETURNING
        .mockResolvedValueOnce({}) // INSERT task_logs (logTaskEvent)
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({
          rows: [{ ...newTask, reporter_name: null, assignee_name: null }],
        });

      const response = await request(app).post('/api/v1/tasks').send({ title: 'Test Task' });

      expect(response.status).toBe(201);
      const insertCall = mockClient.query.mock.calls.find((c) =>
        c[0].includes('INSERT INTO tasks'),
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall[1];
      expect(insertParams[insertParams.length - 1]).toBeNull();
    });
  });

  describe('PUT /api/v1/tasks/:id with preferred_model', () => {
    const taskId = '550e8400-e29b-41d4-a716-446655440000';

    it('should update preferred_model', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      pool.connect.mockResolvedValue(mockClient);

      const existingTask = {
        id: taskId,
        title: 'Existing',
        summary: null,
        description: null,
        status: 'PLANNING',
        priority: null,
        type: 'task',
        reporter_id: null,
        assignee_id: null,
        due_date: null,
        done_at: null,
        archived_at: null,
        tags: null,
        parent_task_id: null,
        preferred_model: null,
      };

      const updatedTask = {
        ...existingTask,
        preferred_model: 'openrouter/google/gemini-2.5-flash',
      };

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [existingTask] }) // SELECT existing
        .mockResolvedValueOnce({ rows: [updatedTask] }) // UPDATE RETURNING
        .mockResolvedValueOnce({}) // INSERT task_logs (logTaskEvent)
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({
          rows: [{ ...updatedTask, reporter_name: null, assignee_name: null }],
        }); // SELECT complete

      const response = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .send({ preferred_model: 'openrouter/google/gemini-2.5-flash' });

      expect(response.status).toBe(200);
      expect(response.body.data.preferred_model).toBe('openrouter/google/gemini-2.5-flash');
    });

    it('should reject empty preferred_model on update', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      pool.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: taskId, title: 'Existing', preferred_model: null }],
        }) // SELECT existing
        .mockResolvedValueOnce({}); // ROLLBACK (validation fails)

      const response = await request(app)
        .put(`/api/v1/tasks/${taskId}`)
        .send({ preferred_model: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('preferred_model must be a non-empty string');
    });
  });
});
