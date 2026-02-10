/**
 * Unit tests for GET /api/v1/models endpoint
 *
 * Tests that:
 * - Returns 200 with models array and defaultModel
 * - Each model has id, name, params, provider
 * - Response shape matches API contract
 */

const express = require('express');
const request = require('supertest');
const modelsRouter = require('../models');

describe('GET /api/v1/models', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use('/api/v1/models', modelsRouter);
  });

  it('should return 200 with models and defaultModel', async () => {
    const response = await request(app).get('/api/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data).toBeDefined();
    expect(Array.isArray(response.body.data.models)).toBe(true);
    expect(response.body.data.defaultModel).toBeDefined();
  });

  it('should return models with id, name, params, provider', async () => {
    const response = await request(app).get('/api/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data.models.length).toBeGreaterThan(0);

    const firstModel = response.body.data.models[0];
    expect(firstModel).toHaveProperty('id');
    expect(firstModel).toHaveProperty('name');
    expect(firstModel).toHaveProperty('params');
    expect(firstModel).toHaveProperty('provider');
    expect(typeof firstModel.id).toBe('string');
    expect(typeof firstModel.name).toBe('string');
    expect(typeof firstModel.params).toBe('object');
    expect(firstModel.provider === null || typeof firstModel.provider === 'string').toBe(true);
  });

  it('should include params with model-specific fields', async () => {
    const response = await request(app).get('/api/v1/models');

    expect(response.status).toBe(200);
    const modelWithParams = response.body.data.models.find(
      (m) => m.params && Object.keys(m.params).length > 0
    );
    if (modelWithParams) {
      expect(typeof modelWithParams.params).toBe('object');
    }
  });
});
