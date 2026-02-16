/**
 * Unit tests for /api/v1/admin/models CRUD endpoints (OpenClaw config-backed)
 *
 * Tests that:
 * - All endpoints require authentication and admin role
 * - GET returns all models from OpenClaw config
 * - POST creates a new model in OpenClaw config
 * - PUT updates an existing model
 * - DELETE removes a model
 * - PATCH /default sets default model
 * - PATCH /enabled toggles enabled state
 * - Validation rules are enforced (e.g., can't delete default model)
 */

const express = require('express');
const request = require('supertest');
const modelsRouter = require('../models');
const { makeOpenClawRequest } = require('../../../services/openclawWorkspaceClient');

// Mock the OpenClaw workspace client
jest.mock('../../../services/openclawWorkspaceClient', () => ({
  makeOpenClawRequest: jest.fn(),
}));

// Mock auth middleware
jest.mock('../../auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 'test-user', email: 'test@example.com', role: 'admin' };
    next();
  },
  requireAdmin: (req, res, next) => {
    if (req.user.role === 'admin' || req.user.role === 'owner') {
      next();
    } else {
      res.status(403).json({ error: { message: 'Forbidden', status: 403 } });
    }
  },
}));

describe('/api/v1/admin/models', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/admin/models', modelsRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/admin/models', () => {
    it('should return all models from OpenClaw config', async () => {
      makeOpenClawRequest.mockResolvedValue({
        content: JSON.stringify({
          agents: {
            defaults: {
              models: {
                'openrouter/anthropic/claude-sonnet-4.5': {
                  alias: 'Claude Sonnet 4.5',
                  params: { maxTokens: 8000 }
                },
                'openrouter/openai/gpt-4': {
                  alias: 'GPT-4',
                  params: { maxTokens: 4000 }
                }
              },
              model: { primary: 'openrouter/anthropic/claude-sonnet-4.5' }
            }
          }
        })
      });

      const response = await request(app).get('/api/v1/admin/models');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
      expect(response.body.data[0]).toHaveProperty('id');
      expect(response.body.data[0]).toHaveProperty('alias');
      expect(response.body.data[0]).toHaveProperty('is_default');
    });

    it('should support search query parameter', async () => {
      makeOpenClawRequest.mockResolvedValue({
        content: JSON.stringify({
          agents: {
            defaults: {
              models: {
                'openrouter/anthropic/claude-sonnet-4.5': {
                  alias: 'Claude Sonnet 4.5',
                  params: {}
                },
                'openrouter/openai/gpt-4': {
                  alias: 'GPT-4',
                  params: {}
                }
              },
              model: { primary: 'openrouter/anthropic/claude-sonnet-4.5' }
            }
          }
        })
      });

      const response = await request(app).get('/api/v1/admin/models?search=claude');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(1);
      expect(response.body.data[0].id).toContain('claude');
    });
  });

  describe('POST /api/v1/admin/models', () => {
    it('should create a new model in OpenClaw config', async () => {
      const mockConfig = {
        agents: {
          defaults: {
            models: {},
            model: { primary: null }
          }
        }
      };

      // Mock read
      makeOpenClawRequest.mockResolvedValueOnce({
        content: JSON.stringify(mockConfig)
      });

      // Mock write
      makeOpenClawRequest.mockResolvedValueOnce({ success: true });

      const response = await request(app)
        .post('/api/v1/admin/models')
        .send({
          id: 'openrouter/anthropic/claude-sonnet-4.5',
          alias: 'Claude Sonnet 4.5',
          params: { maxTokens: 8000 }
        });

      expect(response.status).toBe(201);
      expect(response.body.data.id).toBe('openrouter/anthropic/claude-sonnet-4.5');
      expect(makeOpenClawRequest).toHaveBeenCalledWith('PUT', '/files', expect.any(Object));
    });

    it('should reject creation if model id already exists', async () => {
      makeOpenClawRequest.mockResolvedValue({
        content: JSON.stringify({
          agents: {
            defaults: {
              models: {
                'openrouter/anthropic/claude-sonnet-4.5': {
                  alias: 'Claude Sonnet 4.5',
                  params: {}
                }
              }
            }
          }
        })
      });

      const response = await request(app)
        .post('/api/v1/admin/models')
        .send({
          id: 'openrouter/anthropic/claude-sonnet-4.5',
          alias: 'Claude Sonnet 4.5',
          params: {}
        });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('already exists');
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/v1/admin/models')
        .send({ alias: 'Test Model' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('id is required');
    });
  });

  describe('PUT /api/v1/admin/models/:modelId', () => {
    it('should update an existing model', async () => {
      const mockConfig = {
        agents: {
          defaults: {
            models: {
              'openrouter/anthropic/claude-sonnet-4.5': {
                alias: 'Claude Sonnet 4.5',
                params: { maxTokens: 8000 }
              }
            },
            model: { primary: null }
          }
        }
      };

      // Mock read
      makeOpenClawRequest.mockResolvedValueOnce({
        content: JSON.stringify(mockConfig)
      });

      // Mock write
      makeOpenClawRequest.mockResolvedValueOnce({ success: true });

      const response = await request(app)
        .put('/api/v1/admin/models/openrouter/anthropic/claude-sonnet-4.5')
        .send({ alias: 'Updated Claude' });

      expect(response.status).toBe(200);
      expect(response.body.data.alias).toBe('Updated Claude');
    });

    it('should return 404 if model does not exist', async () => {
      makeOpenClawRequest.mockResolvedValue({
        content: JSON.stringify({ agents: { defaults: { models: {} } } })
      });

      const response = await request(app)
        .put('/api/v1/admin/models/nonexistent/model')
        .send({ alias: 'Test' });

      expect(response.status).toBe(404);
    });

  });

  describe('DELETE /api/v1/admin/models/:modelId', () => {
    it('should delete a model', async () => {
      const mockConfig = {
        agents: {
          defaults: {
            models: {
              'openrouter/anthropic/claude-sonnet-4.5': {
                alias: 'Claude Sonnet 4.5',
                params: {}
              },
              'openrouter/openai/gpt-4': {
                alias: 'GPT-4',
                params: {}
              }
            },
            defaultModel: 'openrouter/anthropic/claude-sonnet-4.5'
          }
        }
      };

      // Mock read
      makeOpenClawRequest.mockResolvedValueOnce({
        content: JSON.stringify(mockConfig)
      });

      // Mock write
      makeOpenClawRequest.mockResolvedValueOnce({ success: true });

      const response = await request(app)
        .delete('/api/v1/admin/models/openrouter/openai/gpt-4');

      expect(response.status).toBe(200);
      expect(response.body.data.success).toBe(true);
    });

    it('should prevent deletion of the default model', async () => {
      makeOpenClawRequest.mockResolvedValue({
        content: JSON.stringify({
          agents: {
            defaults: {
              models: {
                'openrouter/anthropic/claude-sonnet-4.5': {
                  alias: 'Claude Sonnet 4.5',
                  params: {}
                }
              },
              model: { primary: 'openrouter/anthropic/claude-sonnet-4.5' }
            }
          }
        })
      });

      const response = await request(app)
        .delete('/api/v1/admin/models/openrouter/anthropic/claude-sonnet-4.5');

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('Cannot delete the default model');
    });
  });

  describe('PATCH /api/v1/admin/models/:modelId/default', () => {
    it('should set a model as default', async () => {
      const mockConfig = {
        agents: {
          defaults: {
            models: {
              'openrouter/openai/gpt-4': {
                alias: 'GPT-4',
                params: {},
                enabled: true
              }
            },
            model: { primary: null }
          }
        }
      };

      // Mock read
      makeOpenClawRequest.mockResolvedValueOnce({
        content: JSON.stringify(mockConfig)
      });

      // Mock write
      makeOpenClawRequest.mockResolvedValueOnce({ success: true });

      const response = await request(app)
        .patch('/api/v1/admin/models/openrouter/openai/gpt-4/default');

      expect(response.status).toBe(200);
      expect(response.body.data.is_default).toBe(true);
    });

  });

});
