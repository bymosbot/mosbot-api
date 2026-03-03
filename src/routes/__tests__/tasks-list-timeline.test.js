const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require('../../db/pool');
const tasksRouter = require('../tasks');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: { message: err.message, status: err.status || 500 },
    });
  });
  return app;
}

describe('tasks list and timeline routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    app = makeApp();
  });

  describe('GET /api/v1/tasks', () => {
    it('lists tasks and excludes ARCHIVE by default', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app).get('/api/v1/tasks');
      expect(res.status).toBe(200);
      expect(pool.query.mock.calls[0][0]).toContain("t.status != 'ARCHIVE'");
    });

    it('includes archived tasks when include_archived=true', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app).get('/api/v1/tasks?include_archived=true');
      expect(res.status).toBe(200);
      expect(pool.query.mock.calls[0][0]).not.toContain("t.status != 'ARCHIVE'");
    });

    it('applies done_after and done_within_hours filters when valid', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app).get(
        '/api/v1/tasks?done_after=2026-03-01T00:00:00Z&done_within_hours=12',
      );
      expect(res.status).toBe(200);
      const [query, params] = pool.query.mock.calls[0];
      expect(query).toContain('t.done_at >=');
      expect(query).toContain("INTERVAL '1 hour'");
      expect(params).toContain(12);
    });

    it('ignores invalid done filters and still returns 200', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app).get('/api/v1/tasks?done_after=not-a-date&done_within_hours=0');
      expect(res.status).toBe(200);
      const [query, params] = pool.query.mock.calls[0];
      expect(query).not.toContain("INTERVAL '1 hour'");
      expect(params).toHaveLength(2); // only limit + offset
    });

    it('continues without auth user when bearer token is invalid', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/v1/tasks')
        .set('Authorization', 'Bearer definitely-invalid');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/tasks/:id/timeline', () => {
    const taskId = '550e8400-e29b-41d4-a716-446655440000';

    it('returns 404 when task does not exist', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get(`/api/v1/tasks/${taskId}/timeline`);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Task not found');
    });

    it('returns merged and chronologically sorted timeline', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: taskId }] }) // task exists
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'c1',
              type: 'comment',
              body: 'later comment',
              occurred_at: '2026-03-03T10:05:00.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'e1',
              type: 'event',
              event_type: 'STATUS_CHANGED',
              occurred_at: '2026-03-03T10:00:00.000Z',
            },
          ],
        });

      const res = await request(app).get(`/api/v1/tasks/${taskId}/timeline`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].id).toBe('e1');
      expect(res.body.data[1].id).toBe('c1');
    });
  });

  describe('GET /api/v1/tasks/:id', () => {
    it('should reject invalid UUID format', async () => {
      const res = await request(app).get('/api/v1/tasks/invalid-uuid');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Invalid UUID format');
    });

    it('should handle database error', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const res = await request(app).get('/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000');

      expect(res.status).toBe(500);
    });
  });

  describe('Error handling', () => {
    it('should handle database error on GET /tasks', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const res = await request(app).get('/api/v1/tasks');

      expect(res.status).toBe(500);
    });
  });
});
