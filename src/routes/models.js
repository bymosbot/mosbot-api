const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Load models config
const modelsConfigPath = path.join(__dirname, '../config/models.json');
let modelsConfig = null;

try {
  const configData = fs.readFileSync(modelsConfigPath, 'utf8');
  modelsConfig = JSON.parse(configData);
  const modelCount = modelsConfig.models && typeof modelsConfig.models === 'object'
    ? Object.keys(modelsConfig.models).length
    : 0;
  logger.info('Models config loaded successfully', { modelCount });
} catch (error) {
  logger.error('Failed to load models config', error);
  modelsConfig = { models: {}, defaultModel: null };
}

// Transform models object to array for API response
function getModelsForApi() {
  if (!modelsConfig?.models || typeof modelsConfig.models !== 'object') {
    return [];
  }
  return Object.entries(modelsConfig.models).map(([id, config]) => ({
    id,
    name: config.alias || id,
    params: config.params || {},
    provider: id.split('/')[1] || null,
  }));
}

// GET /api/v1/models - List available AI models
router.get('/', async (req, res, next) => {
  try {
    res.json({
      data: {
        models: getModelsForApi(),
        defaultModel: modelsConfig.defaultModel
      }
    });
  } catch (error) {
    next(error);
  }
});

// Helper function to get provider for a model ID (from path: openrouter/anthropic/... -> anthropic)
function getProviderForModel(modelId) {
  if (!modelsConfig?.models || !modelId) {
    return null;
  }
  const segments = modelId.split('/');
  return segments.length >= 2 ? segments[1] : null;
}

module.exports = router;
module.exports.getProviderForModel = getProviderForModel;
