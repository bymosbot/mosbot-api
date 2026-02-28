/**
 * Tests for the activity feed endpoint (GET /api/v1/activity/feed).
 *
 * Verifies:
 * - Feed returns only activity_logs rows (no session_usage merge)
 * - New fields (event_type, severity, source, job_id, session_key, links) are returned
 * - Filtering by event_type, severity, source, job_id, session_key works
 * - Pagination works correctly
 * - POST / accepts new v2 fields and deduplicates via dedupe_key
 */

const request = require('supertest');
const express = require('express');
const activityRouter = require('../activity');

// Mock the database pool
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../../db/pool');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/activity', activityRouter);
  app.use((err, req, res, _next) => {
    res
      .status(err.status || 500)
      .json({ error: { message: err.message, status: err.status || 500 } });
  });
  return app;
}

const SAMPLE_ROW = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  timestamp: '2025-01-01T10:00:00Z',
  title: 'Cron run: my-job',
  description: 'Cron job executed',
  category: null,
  event_type: 'cron_run',
  severity: 'info',
  source: 'cron',
  agent_id: 'coo',
  task_id: null,
  job_id: 'my-job',
  session_key: 'agent:coo:cron:my-job:run:abc123',
  run_id: 'abc123',
  workspace_path: null,
  meta: { model: 'claude-sonnet', cost_usd: 0.01 },
  actor_user_id: null,
  created_at: '2025-01-01T10:00:00Z',
  task_title: null,
  agent_name: 'COO',
  agent_avatar: null,
  actor_name: null,
};

describe('GET /api/v1/activity/feed', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
  });

  it('returns rows from activity_logs with unified fields', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_ROW] }) // data query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count query

    const res = await request(app).get('/api/v1/activity/feed');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    expect(row.event_type).toBe('cron_run');
    expect(row.severity).toBe('info');
    expect(row.source).toBe('cron');
    expect(row.job_id).toBe('my-job');
    expect(row.session_key).toBe('agent:coo:cron:my-job:run:abc123');
  });

  it('computes links object for rows with job_id and session_key', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_ROW] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity/feed');

    expect(res.status).toBe(200);
    const { links } = res.body.data[0];
    expect(links).toBeDefined();
    expect(links.session).toBeDefined();
    expect(links.session.href).toContain('/monitor?sessionKey=');
    expect(links.job).toBeDefined();
    expect(links.job.href).toContain('/scheduler?jobId=my-job');
  });

  it('computes task link when task_id is present', async () => {
    const rowWithTask = {
      ...SAMPLE_ROW,
      task_id: 'bbbbbbbb-0000-0000-0000-000000000002',
      task_title: 'My Task',
      job_id: null,
      session_key: null,
    };
    pool.query
      .mockResolvedValueOnce({ rows: [rowWithTask] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity/feed');

    expect(res.status).toBe(200);
    const { links } = res.body.data[0];
    expect(links.task).toBeDefined();
    expect(links.task.href).toBe('/task/bbbbbbbb-0000-0000-0000-000000000002');
    expect(links.task.label).toBe('My Task');
  });

  it('computes Projects workspace link for /shared/projects paths', async () => {
    const rowWithWorkspace = {
      ...SAMPLE_ROW,
      workspace_path: '/shared/projects/foo/plan.md',
      job_id: null,
      session_key: null,
    };
    pool.query
      .mockResolvedValueOnce({ rows: [rowWithWorkspace] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/activity/feed');

    expect(res.status).toBe(200);
    const { links } = res.body.data[0];
    expect(links.workspace).toBeDefined();
    expect(links.workspace.href).toBe('/projects');
  });

  it('filters by event_type', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await request(app).get('/api/v1/activity/feed?event_type=cron_run');

    const callArgs = pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('al.event_type =');
    expect(callArgs[1]).toContain('cron_run');
  });

  it('filters by severity', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await request(app).get('/api/v1/activity/feed?severity=attention');

    const callArgs = pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('al.severity =');
    expect(callArgs[1]).toContain('attention');
  });

  it('filters by job_id', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await request(app).get('/api/v1/activity/feed?job_id=my-job');

    const callArgs = pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('al.job_id =');
    expect(callArgs[1]).toContain('my-job');
  });

  it('filters by session_key', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await request(app).get('/api/v1/activity/feed?session_key=agent%3Acoo%3Amain');

    const callArgs = pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('al.session_key =');
    expect(callArgs[1]).toContain('agent:coo:main');
  });

  it('returns pagination metadata', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_ROW] })
      .mockResolvedValueOnce({ rows: [{ total: '42' }] });

    const res = await request(app).get('/api/v1/activity/feed?limit=10&offset=0');

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ limit: 10, offset: 0, total: 42 });
  });

  it('rejects invalid task_id UUID', async () => {
    const res = await request(app).get('/api/v1/activity/feed?task_id=not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid UUID');
  });
});

describe('POST /api/v1/activity', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
  });

  it('creates an activity log with v2 fields', async () => {
    const newRow = {
      id: 'cccccccc-0000-0000-0000-000000000003',
      title: 'Workspace file created',
      description: 'File created at /shared/projects/foo.md',
      event_type: 'workspace_file_created',
      severity: 'info',
      source: 'workspace',
      workspace_path: '/shared/projects/foo.md',
      meta: null,
      dedupe_key: null,
      created_at: '2025-01-01T10:00:00Z',
    };

    pool.query.mockResolvedValueOnce({ rows: [newRow] });

    const res = await request(app).post('/api/v1/activity').send({
      title: 'Workspace file created',
      description: 'File created at /shared/projects/foo.md',
      event_type: 'workspace_file_created',
      severity: 'info',
      source: 'workspace',
      workspace_path: '/shared/projects/foo.md',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.event_type).toBe('workspace_file_created');
    expect(res.body.data.source).toBe('workspace');
  });

  it('rejects invalid event_type', async () => {
    const res = await request(app).post('/api/v1/activity').send({
      title: 'Test',
      description: 'Test',
      event_type: 'invalid_event_type',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid event_type');
  });

  it('rejects invalid severity', async () => {
    const res = await request(app).post('/api/v1/activity').send({
      title: 'Test',
      description: 'Test',
      severity: 'critical',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid severity');
  });

  it('returns 200 with deduplicated:true when dedupe_key already exists', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING returns 0 rows

    const res = await request(app).post('/api/v1/activity').send({
      title: 'Cron run',
      description: 'Already ingested',
      event_type: 'cron_run',
      source: 'cron',
      dedupe_key: 'session:agent:coo:cron:my-job:run:abc123',
    });

    expect(res.status).toBe(200);
    expect(res.body.deduplicated).toBe(true);
  });
});
