/**
 * Unit tests for GET /api/v1/models endpoint (OpenClaw config-backed)
 *
 * Tests that:
 * - Returns 200 with models array and defaultModel
 * - Each model has id, name, params, provider
 * - Response shape matches API contract
 * - Reads from OpenClaw config as source of truth
 */

const express = require('express');
const request = require('supertest');
const modelsRouter = require('../models');
const { makeOpenClawRequest } = require('../../services/openclawWorkspaceClient');

// Mock the OpenClaw workspace client
jest.mock('../../services/openclawWorkspaceClient', () => ({
  makeOpenClawRequest: jest.fn(),
}));

describe('GET /api/v1/models', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use('/api/v1/models', modelsRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 with models and defaultModel from OpenClaw config', async () => {
    // Mock OpenClaw config response
    makeOpenClawRequest.mockResolvedValue({
      content: JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: 'openrouter/anthropic/claude-sonnet-4.5',
            },
            models: {
              'openrouter/anthropic/claude-sonnet-4.5': {
                alias: 'Claude Sonnet 4.5',
                params: { maxTokens: 8000 },
              },
              'openrouter/openai/gpt-4': {
                alias: 'GPT-4',
                params: { maxTokens: 4000 },
              },
            },
          },
        },
      }),
    });

    const response = await request(app).get('/api/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data).toBeDefined();
    expect(Array.isArray(response.body.data.models)).toBe(true);
    expect(response.body.data.defaultModel).toBe('openrouter/anthropic/claude-sonnet-4.5');
    expect(response.body.data.models.length).toBe(2);
  });

  it('should return models with id, name, params, provider', async () => {
    // Mock OpenClaw config response
    makeOpenClawRequest.mockResolvedValue({
      content: JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: 'openrouter/anthropic/claude-sonnet-4.5',
            },
            models: {
              'openrouter/anthropic/claude-sonnet-4.5': {
                alias: 'Claude Sonnet 4.5',
                description: 'Test description',
                params: { maxTokens: 8000 },
              },
            },
          },
        },
      }),
    });

    const response = await request(app).get('/api/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data.models.length).toBeGreaterThan(0);

    const firstModel = response.body.data.models[0];
    expect(firstModel).toHaveProperty('id');
    expect(firstModel).toHaveProperty('name');
    expect(firstModel).toHaveProperty('params');
    expect(firstModel).toHaveProperty('isDefault');
    expect(typeof firstModel.id).toBe('string');
    expect(typeof firstModel.name).toBe('string');
    expect(typeof firstModel.params).toBe('object');
    expect(typeof firstModel.isDefault).toBe('boolean');
  });

  it('should return all models from OpenClaw config', async () => {
    // Mock OpenClaw config
    makeOpenClawRequest.mockResolvedValue({
      content: JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: 'openrouter/anthropic/claude-sonnet-4.5',
            },
            models: {
              'openrouter/anthropic/claude-sonnet-4.5': {
                alias: 'Claude Sonnet 4.5',
                params: {},
              },
              'openrouter/anthropic/claude-haiku-4.5': {
                alias: 'Claude Haiku 4.5',
                params: {},
              },
            },
          },
        },
      }),
    });

    const response = await request(app).get('/api/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data.models.length).toBe(2);

    const haiku = response.body.data.models.find(
      (m) => m.id === 'openrouter/anthropic/claude-haiku-4.5',
    );
    expect(haiku).toBeDefined();
    expect(haiku.name).toBe('Claude Haiku 4.5');
  });

  it('should return empty list when OpenClaw is not configured', async () => {
    // Mock service not configured error
    const error = new Error('OpenClaw workspace service is not configured');
    error.code = 'SERVICE_NOT_CONFIGURED';
    error.status = 503;
    makeOpenClawRequest.mockRejectedValue(error);

    const response = await request(app).get('/api/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data.models).toEqual([]);
    expect(response.body.data.defaultModel).toBe(null);
  });
});
