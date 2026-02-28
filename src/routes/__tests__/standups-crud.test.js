/**
 * Unit tests for standup CRUD endpoints
 *
 * Validates:
 * - auth/role requirements for mutations
 * - input validation for POST/PATCH
 * - 404 handling for unknown IDs
 * - happy paths for all CRUD operations
 * - /run endpoint (mocked OpenClaw gateway)
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock('../../services/standupService', () => ({
  runStandupById: jest.fn(),
}));

const pool = require('../../db/pool');
const { runStandupById } = require('../../services/standupService');
const standupsRouter = require('../standups');

const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production';
const STANDUP_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ENTRY_UUID = '550e8400-e29b-41d4-a716-446655440001';
const MSG_UUID = '550e8400-e29b-41d4-a716-446655440002';
const BAD_UUID = 'not-a-uuid';

function makeToken(userId = 'user-id', role = 'user') {
  return jwt.sign({ id: userId, role, email: `${role}@test.com` }, JWT_SECRET, { expiresIn: '1h' });
}

function makeStandup(overrides = {}) {
  return {
    id: STANDUP_UUID,
    standup_date: '2026-02-18',
    title: 'Executive Standup — Tuesday, February 18, 2026',
    timezone: 'Asia/Singapore',
    status: 'completed',
    started_at: '2026-02-18T00:08:00.000Z',
    completed_at: '2026-02-18T00:12:00.000Z',
    created_at: '2026-02-18T00:08:00.000Z',
    updated_at: '2026-02-18T00:12:00.000Z',
    ...overrides,
  };
}

function mockAuthUser(role = 'user') {
  pool.query.mockResolvedValueOnce({
    rows: [{ id: 'user-id', role, active: true }],
  });
}

describe('Standups CRUD (Unit Tests)', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/standups', standupsRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // GET /standups
  // --------------------------------------------------------------------------
  describe('GET /api/v1/standups', () => {
    it('should require authentication', async () => {
      const res = await request(app).get('/api/v1/standups');
      expect(res.status).toBe(401);
    });

    it('should return paginated standups list', async () => {
      mockAuthUser('user');
      pool.query
        .mockResolvedValueOnce({ rows: [{ ...makeStandup(), entry_count: 2, participants: [] }] })
        .mockResolvedValueOnce({ rows: [{ total: 1 }] });

      const res = await request(app)
        .get('/api/v1/standups')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // GET /standups/latest
  // --------------------------------------------------------------------------
  describe('GET /api/v1/standups/latest', () => {
    it('should return 404 when no standups exist', async () => {
      mockAuthUser('user');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/standups/latest')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(404);
    });

    it('should return the latest standup', async () => {
      mockAuthUser('user');
      pool.query.mockResolvedValueOnce({
        rows: [{ ...makeStandup(), entry_count: 4, participants: [] }],
      });

      const res = await request(app)
        .get('/api/v1/standups/latest')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(STANDUP_UUID);
    });
  });

  // --------------------------------------------------------------------------
  // POST /standups
  // --------------------------------------------------------------------------
  describe('POST /api/v1/standups', () => {
    it('should require authentication', async () => {
      const res = await request(app).post('/api/v1/standups').send({});
      expect(res.status).toBe(401);
    });

    it('should require admin/agent/owner role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .post('/api/v1/standups')
        .set('Authorization', `Bearer ${makeToken('u', 'user')}`)
        .send({ standup_date: '2026-02-18', title: 'Test', timezone: 'UTC' });

      expect(res.status).toBe(403);
    });

    it('should reject missing standup_date', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .post('/api/v1/standups')
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ title: 'Test', timezone: 'UTC' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/standup_date/);
    });

    it('should reject missing title', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .post('/api/v1/standups')
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ standup_date: '2026-02-18', timezone: 'UTC' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/title/);
    });

    it('should reject invalid status', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .post('/api/v1/standups')
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ standup_date: '2026-02-18', title: 'T', timezone: 'UTC', status: 'bad' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/status/);
    });

    it('should create standup successfully', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [makeStandup()] });

      const res = await request(app)
        .post('/api/v1/standups')
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({
          standup_date: '2026-02-18',
          title: 'Executive Standup — Tuesday, February 18, 2026',
          timezone: 'Asia/Singapore',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe(STANDUP_UUID);
    });

    it('should return 409 on duplicate date', async () => {
      mockAuthUser('admin');
      const pgError = new Error('duplicate key');
      pgError.code = '23505';
      pool.query.mockRejectedValueOnce(pgError);

      const res = await request(app)
        .post('/api/v1/standups')
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ standup_date: '2026-02-18', title: 'T', timezone: 'UTC' });

      expect(res.status).toBe(409);
    });
  });

  // --------------------------------------------------------------------------
  // GET /standups/:id
  // --------------------------------------------------------------------------
  describe('GET /api/v1/standups/:id', () => {
    it('should return 400 for invalid UUID', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .get(`/api/v1/standups/${BAD_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(400);
    });

    it('should return 404 when standup not found', async () => {
      mockAuthUser('user');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(404);
    });

    it('should return standup with entries and messages', async () => {
      mockAuthUser('user');
      pool.query
        .mockResolvedValueOnce({ rows: [makeStandup()] }) // standup
        .mockResolvedValueOnce({ rows: [] }) // entries
        .mockResolvedValueOnce({ rows: [] }); // messages

      const res = await request(app)
        .get(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.entries).toBeDefined();
      expect(res.body.data.messages).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // PATCH /standups/:id
  // --------------------------------------------------------------------------
  describe('PATCH /api/v1/standups/:id', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should reject empty title', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ title: '   ' });

      expect(res.status).toBe(400);
    });

    it('should reject invalid status', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ status: 'invalid' });

      expect(res.status).toBe(400);
    });

    it('should return 400 with no fields', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('No fields to update');
    });

    it('should update standup status successfully', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [makeStandup({ status: 'error' })] });

      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ status: 'error' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('error');
    });

    it('should return 404 when standup not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ status: 'error' });

      expect(res.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /standups/:id
  // --------------------------------------------------------------------------
  describe('DELETE /api/v1/standups/:id', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should return 404 when standup not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(404);
    });

    it('should delete standup and return 204', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [{ id: STANDUP_UUID }] });

      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(204);
    });
  });

  // --------------------------------------------------------------------------
  // POST /standups/:id/run
  // --------------------------------------------------------------------------
  describe('POST /api/v1/standups/:id/run', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/run`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should return 404 when standup not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/run`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(404);
    });

    it('should return 500 when runStandupById returns error', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [makeStandup()] });
      runStandupById.mockResolvedValueOnce({ status: 'error', message: 'No agent users found' });

      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/run`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(500);
    });

    it('should run standup and return updated record', async () => {
      mockAuthUser('admin');
      pool.query
        .mockResolvedValueOnce({ rows: [makeStandup({ status: 'running' })] }) // fetch standup
        .mockResolvedValueOnce({ rows: [makeStandup({ status: 'completed' })] }); // fetch updated

      runStandupById.mockResolvedValueOnce({
        status: 'completed',
        agentCount: 4,
        durationMs: 5000,
      });

      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/run`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
      expect(runStandupById).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // POST /standups/:id/entries
  // --------------------------------------------------------------------------
  describe('POST /api/v1/standups/:id/entries', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/entries`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should reject missing agent_id', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/entries`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ raw: 'Yesterday: done\nToday: working' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/agent_id/);
    });

    it('should reject missing raw', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/entries`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ agent_id: 'coo' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/raw/);
    });

    it('should return 404 when standup not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/entries`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ agent_id: 'coo', raw: 'Yesterday: done' });

      expect(res.status).toBe(404);
    });

    it('should create entry successfully', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [{ id: STANDUP_UUID }] }).mockResolvedValueOnce({
        rows: [
          {
            id: ENTRY_UUID,
            standup_id: STANDUP_UUID,
            agent_id: 'coo',
            user_id: null,
            turn_order: 1,
            yesterday: 'done',
            today: 'working',
            blockers: null,
            tasks: null,
            raw: 'Yesterday: done\nToday: working',
            created_at: '2026-02-18T00:08:30.000Z',
          },
        ],
      });

      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/entries`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ agent_id: 'coo', turn_order: 1, raw: 'Yesterday: done\nToday: working' });

      expect(res.status).toBe(201);
      expect(res.body.data.agent_id).toBe('coo');
    });
  });

  // --------------------------------------------------------------------------
  // PATCH /standups/:id/entries/:entryId
  // --------------------------------------------------------------------------
  describe('PATCH /api/v1/standups/:id/entries/:entryId', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}/entries/${ENTRY_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should return 404 when entry not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}/entries/${ENTRY_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ today: 'new today' });

      expect(res.status).toBe(404);
    });

    it('should return 400 with no fields', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [{ id: ENTRY_UUID }] });

      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}/entries/${ENTRY_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('No fields to update');
    });

    it('should update entry today field', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [{ id: ENTRY_UUID }] }).mockResolvedValueOnce({
        rows: [{ id: ENTRY_UUID, today: 'new today', agent_id: 'coo', raw: 'raw' }],
      });

      const res = await request(app)
        .patch(`/api/v1/standups/${STANDUP_UUID}/entries/${ENTRY_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ today: 'new today' });

      expect(res.status).toBe(200);
      expect(res.body.data.today).toBe('new today');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /standups/:id/entries/:entryId
  // --------------------------------------------------------------------------
  describe('DELETE /api/v1/standups/:id/entries/:entryId', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}/entries/${ENTRY_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should return 404 when entry not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}/entries/${ENTRY_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(404);
    });

    it('should delete entry and return 204', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [{ id: ENTRY_UUID }] });

      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}/entries/${ENTRY_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(204);
    });
  });

  // --------------------------------------------------------------------------
  // POST /standups/:id/messages
  // --------------------------------------------------------------------------
  describe('POST /api/v1/standups/:id/messages', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/messages`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should reject invalid kind', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/messages`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ kind: 'bot', content: 'Hello' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/kind/);
    });

    it('should reject missing content', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/messages`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ kind: 'agent' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/content/);
    });

    it('should return 404 when standup not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/messages`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ kind: 'agent', content: 'Hello' });

      expect(res.status).toBe(404);
    });

    it('should create message successfully', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [{ id: STANDUP_UUID }] }).mockResolvedValueOnce({
        rows: [
          {
            id: MSG_UUID,
            standup_id: STANDUP_UUID,
            kind: 'agent',
            agent_id: 'coo',
            content: 'Yesterday: done',
            created_at: '2026-02-18T00:08:30.000Z',
          },
        ],
      });

      const res = await request(app)
        .post(`/api/v1/standups/${STANDUP_UUID}/messages`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ kind: 'agent', agent_id: 'coo', content: 'Yesterday: done' });

      expect(res.status).toBe(201);
      expect(res.body.data.kind).toBe('agent');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /standups/:id/messages/:messageId
  // --------------------------------------------------------------------------
  describe('DELETE /api/v1/standups/:id/messages/:messageId', () => {
    it('should require admin role', async () => {
      mockAuthUser('user');
      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}/messages/${MSG_UUID}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(403);
    });

    it('should return 404 when message not found', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}/messages/${MSG_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(404);
    });

    it('should delete message and return 204', async () => {
      mockAuthUser('admin');
      pool.query.mockResolvedValueOnce({ rows: [{ id: MSG_UUID }] });

      const res = await request(app)
        .delete(`/api/v1/standups/${STANDUP_UUID}/messages/${MSG_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(204);
    });
  });

  // --------------------------------------------------------------------------
  // UUID validation shared
  // --------------------------------------------------------------------------
  describe('UUID validation', () => {
    it('should return 400 for invalid UUID on PATCH standup', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .patch(`/api/v1/standups/${BAD_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`)
        .send({ status: 'error' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid UUID on DELETE standup', async () => {
      mockAuthUser('admin');
      const res = await request(app)
        .delete(`/api/v1/standups/${BAD_UUID}`)
        .set('Authorization', `Bearer ${makeToken('a', 'admin')}`);

      expect(res.status).toBe(400);
    });
  });
});
