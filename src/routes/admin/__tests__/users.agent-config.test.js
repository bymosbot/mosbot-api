const express = require('express');
const request = require('supertest');

jest.mock('../../../db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
}));

jest.mock('../../../utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../services/openclawWorkspaceClient', () => ({
  makeOpenClawRequest: jest.fn(),
}));

jest.mock('../../../services/docsLinkReconciliationService', () => ({
  ensureDocsLinkIfMissing: jest.fn().mockResolvedValue({ action: 'unchanged' }),
}));

jest.mock('../../auth', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = {
      id: req.headers['x-test-user-id'] || 'admin-user',
      role: req.headers['x-test-role'] || 'admin',
    };
    next();
  },
  requireManageUsers: (req, res, next) => {
    if (!['admin', 'owner'].includes(req.user?.role)) {
      return res.status(403).json({
        error: { message: 'Admin or owner access required to manage users', status: 403 },
      });
    }
    next();
  },
}));

const pool = require('../../../db/pool');
const logger = require('../../../utils/logger');
const { makeOpenClawRequest } = require('../../../services/openclawWorkspaceClient');
const { ensureDocsLinkIfMissing } = require('../../../services/docsLinkReconciliationService');
const usersRouter = require('../users');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/users', usersRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: { message: err.message, status: err.status || 500 },
    });
  });
  return app;
}

describe('admin users agent config branches', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    makeOpenClawRequest.mockReset();
    ensureDocsLinkIfMissing.mockReset();
    ensureDocsLinkIfMissing.mockResolvedValue({ action: 'unchanged' });
    app = makeApp();
  });

  it('GET / merges OpenClaw agent config when includeAgentConfig=true', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ total: '3' }] }).mockResolvedValueOnce({
      rows: [
        { id: 'u1', role: 'agent', agent_id: 'coo' },
        { id: 'u2', role: 'admin', agent_id: 'cto' },
        { id: 'u3', role: 'user', agent_id: null },
      ],
    });
    makeOpenClawRequest.mockResolvedValueOnce({
      content: JSON.stringify({
        agents: {
          list: [
            { id: 'coo', workspace: '/w-coo', identity: { name: 'COO' }, model: { primary: 'x' } },
            { id: 'cto', workspace: '/w-cto', identity: { name: 'CTO' }, model: { primary: 'y' } },
          ],
        },
      }),
    });

    const res = await request(app).get('/api/v1/admin/users?includeAgentConfig=true');
    expect(res.status).toBe(200);
    expect(res.body.data[0].agentConfig.id).toBe('coo');
    expect(res.body.data[1].agentConfig.id).toBe('cto');
    expect(res.body.data[2].agentConfig).toBeUndefined();
  });

  it('GET / continue without merge when OpenClaw config read fails', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1', role: 'agent', agent_id: 'coo' }] });
    makeOpenClawRequest.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }));

    const res = await request(app).get('/api/v1/admin/users?includeAgentConfig=true');
    expect(res.status).toBe(200);
    expect(res.body.data[0].agentConfig).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to read OpenClaw config for agent merge',
      expect.any(Object),
    );
  });

  it('GET /:id merges agent config for an agent user', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', role: 'agent', agent_id: 'coo' }],
    });
    makeOpenClawRequest.mockResolvedValueOnce({
      content: JSON.stringify({
        agents: { list: [{ id: 'coo', workspace: '/w', identity: { name: 'COO' } }] },
      }),
    });

    const res = await request(app).get('/api/v1/admin/users/u1?includeAgentConfig=true');
    expect(res.status).toBe(400); // invalid UUID from middleware
  });

  it('GET /:id merges agent config using valid UUID', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    pool.query.mockResolvedValueOnce({
      rows: [{ id, role: 'agent', agent_id: 'coo' }],
    });
    makeOpenClawRequest.mockResolvedValueOnce({
      content: JSON.stringify({
        agents: { list: [{ id: 'coo', workspace: '/w', identity: { name: 'COO' } }] },
      }),
    });

    const res = await request(app).get(`/api/v1/admin/users/${id}?includeAgentConfig=true`);
    expect(res.status).toBe(200);
    expect(res.body.data.agentConfig.id).toBe('coo');
  });

  it('PUT /:id demoting agent triggers removeAgentFromConfig flow', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    pool.query
      .mockResolvedValueOnce({ rows: [{ id, role: 'agent', agent_id: 'coo' }] }) // existing
      .mockResolvedValueOnce({ rows: [{ id, role: 'user', agent_id: 'coo' }] }); // update

    makeOpenClawRequest
      .mockResolvedValueOnce({
        content: JSON.stringify({ agents: { list: [{ id: 'coo' }, { id: 'cto' }] } }),
      }) // remove read
      .mockResolvedValueOnce({ ok: true }); // remove write

    const res = await request(app).put(`/api/v1/admin/users/${id}`).send({ role: 'user' });
    expect(res.status).toBe(200);
    expect(makeOpenClawRequest).toHaveBeenCalledWith('GET', '/files/content?path=/openclaw.json');
    expect(makeOpenClawRequest).toHaveBeenCalledWith(
      'PUT',
      '/files',
      expect.objectContaining({ path: '/openclaw.json' }),
    );
  });

  it('PUT /:id demotion still succeeds when removeAgentFromConfig fails', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    pool.query
      .mockResolvedValueOnce({ rows: [{ id, role: 'agent', agent_id: 'coo' }] })
      .mockResolvedValueOnce({ rows: [{ id, role: 'user', agent_id: 'coo' }] });
    // removeAgentFromConfig will fail parsing and hit the warning branch.
    makeOpenClawRequest.mockResolvedValueOnce({ content: '{invalid-json' });

    const res = await request(app).put(`/api/v1/admin/users/${id}`).send({ role: 'user' });
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to remove agent from OpenClaw config',
      expect.any(Object),
    );
  });

  it('PUT /:id/agent rejects non-agent/admin target user role', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    pool.query.mockResolvedValueOnce({
      rows: [{ id, role: 'user', agent_id: null, name: 'Regular', email: 'u@example.com' }],
    });

    const res = await request(app).put(`/api/v1/admin/users/${id}/agent`).send({ agentId: 'coo' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('User must have role "agent" or "admin"');
  });

  it('PUT /:id/agent rejects invalid slug agentId', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    pool.query.mockResolvedValueOnce({
      rows: [{ id, role: 'agent', agent_id: null, name: 'Agent', email: 'a@example.com' }],
    });

    const res = await request(app)
      .put(`/api/v1/admin/users/${id}/agent`)
      .send({ agentId: 'Bad Slug' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('agentId must be a valid slug');
  });

  it('PUT /:id/agent returns 500 when openclaw read fails', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    pool.query.mockResolvedValueOnce({
      rows: [{ id, role: 'agent', agent_id: 'coo', name: 'Agent', email: 'a@example.com' }],
    });
    makeOpenClawRequest.mockRejectedValueOnce(new Error('read failed'));

    const res = await request(app).put(`/api/v1/admin/users/${id}/agent`).send({});
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('Failed to read OpenClaw configuration');
  });

  it('PUT /:id/agent creates new agent and updates DB agent_id', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id, role: 'agent', agent_id: null, name: 'Agent', email: 'a@example.com' }],
      }) // user fetch
      .mockResolvedValueOnce({ rows: [] }) // agent id uniqueness
      .mockResolvedValueOnce({ rows: [] }); // update users set agent_id

    makeOpenClawRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/files/content?path=/openclaw.json') {
        return { content: JSON.stringify({ agents: { list: [] }, meta: {} }) };
      }
      if (method === 'PUT' && path === '/files') {
        return { ok: true };
      }
      // workspace scaffold existence checks -> treat as 404
      if (method === 'GET') {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      if (method === 'POST' && path === '/files') {
        return { ok: true };
      }
      return { ok: true };
    });

    const res = await request(app).put(`/api/v1/admin/users/${id}/agent`).send({ agentId: 'coo' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.agentId).toBe('coo');
    expect(pool.query).toHaveBeenCalledWith('UPDATE users SET agent_id = $1 WHERE id = $2', [
      'coo',
      id,
    ]);
    expect(ensureDocsLinkIfMissing).toHaveBeenCalledWith('coo');
  });
});
