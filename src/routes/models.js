const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { makeOpenClawRequest } = require('../services/openclawWorkspaceClient');

// GET /api/v1/models - List available AI models from OpenClaw config
// Returns models from openclaw.json (OpenClaw is the source of truth)
router.get('/', async (req, res, next) => {
  try {
    // Read openclaw.json from workspace service
    const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
    const config = JSON.parse(configData.content);
    
    // Extract models from agents.defaults.models section
    const modelsObj = config?.agents?.defaults?.models || {};
    const defaultModel = config?.agents?.defaults?.model?.primary || null;
    
    // Transform to API response shape (only OpenClaw-supported fields)
    const models = Object.entries(modelsObj).map(([id, modelConfig]) => ({
      id,
      name: modelConfig.alias || id,
      params: modelConfig.params || {},
      isDefault: id === defaultModel,
    }));
    
    // Sort by name for consistent ordering
    models.sort((a, b) => a.name.localeCompare(b.name));
    
    res.json({
      data: {
        models,
        defaultModel
      }
    });
  } catch (error) {
    // If OpenClaw is not available, log and return empty list
    if (error.code === 'SERVICE_NOT_CONFIGURED' || error.code === 'SERVICE_UNAVAILABLE') {
      logger.warn('OpenClaw not available, returning empty model list', { error: error.message });
      return res.json({
        data: {
          models: [],
          defaultModel: null
        }
      });
    }
    
    logger.error('Failed to fetch models from OpenClaw config', { error: error.message });
    next(error);
  }
});

// Helper function to get provider for a model ID (from path: openrouter/anthropic/... -> anthropic)
function getProviderForModel(modelId) {
  if (!modelId) {
    return null;
  }
  const segments = modelId.split('/');
  return segments.length >= 2 ? segments[1] : null;
}

module.exports = router;
module.exports.getProviderForModel = getProviderForModel;
