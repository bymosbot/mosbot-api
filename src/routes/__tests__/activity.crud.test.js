const request = require('supertest');
const express = require('express');

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
}));

jest.mock('../auth', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { id: 'user-1', role: 'admin' };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

const pool = require('../../db/pool');
const bcrypt = require('bcrypt');
const activityRouter = require('../activity');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/activity', activityRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: { message: err.message, status: err.status || 500 },
    });
  });
  return app;
}

describe('activity routes CRUD/reset', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    bcrypt.compare.mockReset();
    app = makeApp();
  });

  it('GET / returns paginated rows', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?limit=10&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toEqual({ limit: 10, offset: 1, total: 1 });
  });

  it('GET / filters by event_type', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', event_type: 'task_created' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?event_type=task_created');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.event_type = $1'),
      expect.arrayContaining(['task_created']),
    );
  });

  it('GET / filters by severity', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', severity: 'error' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?severity=error');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.severity = $1'),
      expect.arrayContaining(['error']),
    );
  });

  it('GET / filters by source', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', source: 'workspace' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?source=workspace');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.source = $1'),
      expect.arrayContaining(['workspace']),
    );
  });

  it('GET / filters by category', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', category: 'task' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?category=task');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.category = $1'),
      expect.arrayContaining(['task']),
    );
  });

  it('GET / filters by agent_id', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', agent_id: 'agent-123' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?agent_id=agent-123');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.agent_id = $1'),
      expect.arrayContaining(['agent-123']),
    );
  });

  it('GET / filters by job_id', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', job_id: 'job-123' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?job_id=job-123');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.job_id = $1'),
      expect.arrayContaining(['job-123']),
    );
  });

  it('GET / filters by session_key', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', session_key: 'session-123' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?session_key=session-123');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.session_key = $1'),
      expect.arrayContaining(['session-123']),
    );
  });

  it('GET / filters by start_date', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?start_date=2025-01-01');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.timestamp >= $1'),
      expect.arrayContaining(['2025-01-01']),
    );
  });

  it('GET / filters by end_date', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity?end_date=2025-12-31');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.timestamp <= $1'),
      expect.arrayContaining(['2025-12-31']),
    );
  });

  it('GET / filters by multiple parameters', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', title: 'log', severity: 'error', source: 'workspace' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get(
      '/api/v1/activity?severity=error&source=workspace&start_date=2025-01-01&end_date=2025-12-31',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND al.severity = $1'),
      expect.arrayContaining(['error', 'workspace', '2025-01-01', '2025-12-31']),
    );
  });

  it('GET / rejects invalid task_id UUID', async () => {
    const res = await request(app).get('/api/v1/activity?task_id=not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid UUID format for task_id');
  });

  it('GET /:id rejects invalid UUID via middleware', async () => {
    const res = await request(app).get('/api/v1/activity/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid UUID format');
  });

  it('GET /:id returns 404 when row not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/activity/550e8400-e29b-41d4-a716-446655440000');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Activity log not found');
  });

  it('PUT /:id returns 400 when no updatable fields provided', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'x' }] }); // existing check
    const res = await request(app)
      .put('/api/v1/activity/550e8400-e29b-41d4-a716-446655440000')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('No fields to update');
  });

  it('PATCH /:id updates through PUT handler', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'x' }] }) // existing check
      .mockResolvedValueOnce({ rows: [{ id: 'x', title: 'Updated' }] }); // update result

    const res = await request(app)
      .patch('/api/v1/activity/550e8400-e29b-41d4-a716-446655440000')
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Updated');
  });

  it('DELETE /:id returns 404 when row not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).delete('/api/v1/activity/550e8400-e29b-41d4-a716-446655440000');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Activity log not found');
  });

  it('DELETE /:id returns 204 when deleted', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'x' }] });
    const res = await request(app).delete('/api/v1/activity/550e8400-e29b-41d4-a716-446655440000');
    expect(res.status).toBe(204);
  });

  it('POST / rejects invalid source', async () => {
    const res = await request(app).post('/api/v1/activity').send({
      title: 't',
      description: 'd',
      source: 'invalid',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid source');
  });

  it('GET /feed maps non-project workspace path to /workspaces', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'row',
            timestamp: '2025-01-01T00:00:00Z',
            title: 't',
            description: 'd',
            workspace_path: '/home/node/workspace/file.txt',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity/feed');
    expect(res.status).toBe(200);
    expect(res.body.data[0].links.workspace.href).toBe('/workspaces');
  });

  it('GET /feed omits links when row has no linkable fields', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'row',
            timestamp: '2025-01-01T00:00:00Z',
            title: 't',
            description: 'd',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity/feed');
    expect(res.status).toBe(200);
    expect(res.body.data[0].links).toBeUndefined();
  });

  it('POST /reset requires password', async () => {
    const res = await request(app).post('/api/v1/activity/reset').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Password is required');
  });

  it('POST /reset returns 401 when user record not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/v1/activity/reset').send({ password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('User not found');
  });

  it('POST /reset returns 401 for invalid password', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ password_hash: 'hash' }] });
    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await request(app).post('/api/v1/activity/reset').send({ password: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid password');
  });

  it('POST /reset deletes all logs on valid password', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ password_hash: 'hash' }] }) // user fetch
      .mockResolvedValueOnce({ rows: [{ total: '3' }] }) // count
      .mockResolvedValueOnce({}); // delete
    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await request(app).post('/api/v1/activity/reset').send({ password: 'good' });
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.deletedCount).toBe(3);
  });
});
