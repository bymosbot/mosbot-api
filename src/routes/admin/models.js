const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../auth');
const logger = require('../../utils/logger');
const { makeOpenClawRequest } = require('../../services/openclawWorkspaceClient');

// Apply auth middleware to all routes
router.use(authenticateToken);

// Helper to read openclaw.json config
async function readOpenClawConfig() {
  const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
  return JSON.parse(configData.content);
}

// Helper to write openclaw.json config
async function writeOpenClawConfig(config) {
  await makeOpenClawRequest('PUT', '/files', {
    path: '/openclaw.json',
    content: JSON.stringify(config, null, 2),
    encoding: 'utf8'
  });
}

// GET /api/v1/admin/models - List all models from OpenClaw config (admin-only)
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const { search } = req.query;
    
    const config = await readOpenClawConfig();
    const modelsObj = config?.agents?.defaults?.models || {};
    const defaultModel = config?.agents?.defaults?.model?.primary || null;
    
    // Transform to array with full metadata (only OpenClaw-supported fields)
    let models = Object.entries(modelsObj).map(([id, modelConfig]) => ({
      id,
      alias: modelConfig.alias || id,
      params: modelConfig.params || {},
      is_default: id === defaultModel,
    }));
    
    // Apply filters
    if (search) {
      const searchLower = search.toLowerCase();
      models = models.filter(m => 
        m.id.toLowerCase().includes(searchLower) ||
        m.alias.toLowerCase().includes(searchLower)
      );
    }
    
    // Sort by alias
    models.sort((a, b) => a.alias.localeCompare(b.alias));
    
    res.json({
      data: models,
      pagination: {
        limit: models.length,
        offset: 0,
        total: models.length,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch models from OpenClaw config', { error: error.message });
    next(error);
  }
});

// POST /api/v1/admin/models - Create a new model (admin-only)
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { id, alias, params } = req.body;
    
    // Validate required fields
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return res.status(400).json({
        error: { message: 'Model id is required and must be a non-empty string', status: 400 }
      });
    }
    
    if (id.length > 200) {
      return res.status(400).json({
        error: { message: 'Model id must be 200 characters or less', status: 400 }
      });
    }
    
    if (!alias || typeof alias !== 'string' || alias.trim().length === 0) {
      return res.status(400).json({
        error: { message: 'Model alias is required and must be a non-empty string', status: 400 }
      });
    }
    
    // Validate params is required and is an object
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return res.status(400).json({
        error: { message: 'Model params is required and must be an object', status: 400 }
      });
    }
    
    // Read current config
    const config = await readOpenClawConfig();
    
    // Ensure agents.defaults.models exists
    if (!config.agents) {
      config.agents = {};
    }
    if (!config.agents.defaults) {
      config.agents.defaults = {};
    }
    if (!config.agents.defaults.models) {
      config.agents.defaults.models = {};
    }
    
    // Check if model already exists
    if (config.agents.defaults.models[id]) {
      return res.status(409).json({
        error: { message: 'Model with this id already exists', status: 409 }
      });
    }
    
    // Add model to config (only OpenClaw-supported fields)
    config.agents.defaults.models[id] = {
      alias,
      params,
    };
    
    // Write config back
    await writeOpenClawConfig(config);
    
    logger.info('Model created in OpenClaw config', { modelId: id, userId: req.user?.id });
    
    res.status(201).json({
      data: {
        id,
        alias,
        params,
        is_default: false,
      }
    });
  } catch (error) {
    logger.error('Failed to create model', { error: error.message });
    next(error);
  }
});

// PUT /api/v1/admin/models/:modelId(*) - Update a model (admin-only)
router.put('/:modelId(*)', requireAdmin, async (req, res, next) => {
  try {
    const modelId = req.params.modelId;
    const { alias, params } = req.body;
    
    // Read current config
    const config = await readOpenClawConfig();
    
    // Check if model exists
    if (!config.agents?.defaults?.models?.[modelId]) {
      return res.status(404).json({
        error: { message: 'Model not found', status: 404 }
      });
    }
    
    const currentModel = config.agents.defaults.models[modelId];
    const isDefault = config.agents.defaults.model?.primary === modelId;
    
    // Validate alias if provided
    if (alias !== undefined) {
      if (typeof alias !== 'string' || alias.trim().length === 0) {
        return res.status(400).json({
          error: { message: 'Model alias must be a non-empty string', status: 400 }
        });
      }
    }
    
    // Validate params if provided
    if (params !== undefined) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return res.status(400).json({
          error: { message: 'Model params must be an object', status: 400 }
        });
      }
    }
    
    // Update model config (only OpenClaw-supported fields)
    if (alias !== undefined) currentModel.alias = alias;
    if (params !== undefined) currentModel.params = params;
    
    // Write config back
    await writeOpenClawConfig(config);
    
    logger.info('Model updated in OpenClaw config', { modelId, userId: req.user?.id });
    
    res.json({
      data: {
        id: modelId,
        alias: currentModel.alias,
        params: currentModel.params || {},
        is_default: isDefault,
      }
    });
  } catch (error) {
    logger.error('Failed to update model', { error: error.message });
    next(error);
  }
});

// DELETE /api/v1/admin/models/:modelId(*) - Delete a model (admin-only)
router.delete('/:modelId(*)', requireAdmin, async (req, res, next) => {
  try {
    const modelId = req.params.modelId;
    
    // Read current config
    const config = await readOpenClawConfig();
    
    // Check if model exists
    if (!config.agents?.defaults?.models?.[modelId]) {
      return res.status(404).json({
        error: { message: 'Model not found', status: 404 }
      });
    }
    
    const isDefault = config.agents.defaults.model?.primary === modelId;
    
    // Prevent deletion of default model
    if (isDefault) {
      return res.status(400).json({
        error: { message: 'Cannot delete the default model. Set a new default model first.', status: 400 }
      });
    }
    
    // Delete model
    delete config.agents.defaults.models[modelId];
    
    // Write config back
    await writeOpenClawConfig(config);
    
    logger.info('Model deleted from OpenClaw config', { modelId, userId: req.user?.id });
    
    res.json({
      data: { success: true, id: modelId }
    });
  } catch (error) {
    logger.error('Failed to delete model', { error: error.message });
    next(error);
  }
});

// PATCH /api/v1/admin/models/:modelId(*)/default - Set model as default (admin-only)
router.patch('/:modelId(*)/default', requireAdmin, async (req, res, next) => {
  try {
    const modelId = req.params.modelId;
    
    // Read current config
    const config = await readOpenClawConfig();
    
    // Check if model exists
    if (!config.agents?.defaults?.models?.[modelId]) {
      return res.status(404).json({
        error: { message: 'Model not found', status: 404 }
      });
    }
    
    const model = config.agents.defaults.models[modelId];
    
    // Set new default
    if (!config.agents) {
      config.agents = {};
    }
    if (!config.agents.defaults) {
      config.agents.defaults = {};
    }
    if (!config.agents.defaults.model) {
      config.agents.defaults.model = {};
    }
    config.agents.defaults.model.primary = modelId;
    
    // Write config back
    await writeOpenClawConfig(config);
    
    logger.info('Default model changed in OpenClaw config', { modelId, userId: req.user?.id });
    
    res.json({
      data: {
        id: modelId,
        alias: model.alias || modelId,
        params: model.params || {},
        is_default: true,
      }
    });
  } catch (error) {
    logger.error('Failed to set default model', { error: error.message });
    next(error);
  }
});

module.exports = router;
