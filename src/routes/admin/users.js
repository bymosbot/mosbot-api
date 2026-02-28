const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const bcrypt = require('bcrypt');
const { authenticateToken, requireManageUsers } = require('../auth');
const logger = require('../../utils/logger');

// Apply auth middleware to all routes
router.use(authenticateToken);

// Middleware to validate UUID
const validateUUID = (paramName) => (req, res, next) => {
  const id = req.params[paramName];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: { message: 'Invalid UUID format', status: 400 } });
  }
  next();
};

// GET /api/v1/admin/users - List all users (all authenticated users can view)
router.get('/', async (req, res, next) => {
  try {
    const { limit = 100, offset = 0, includeAgentConfig } = req.query;

    // Validate pagination parameters
    const limitNum = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetNum = Math.max(0, parseInt(offset) || 0);

    // Get total count and paginated results in parallel
    const [countResult, dataResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM users'),
      pool.query(
        `
        SELECT id, name, email, avatar_url, role, agent_id, active, created_at, updated_at
        FROM users
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `,
        [limitNum, offsetNum],
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    let users = dataResult.rows;

    // If includeAgentConfig is requested, merge with OpenClaw agent config
    if (includeAgentConfig === 'true') {
      try {
        const { makeOpenClawRequest } = require('../../services/openclawWorkspaceClient');

        // Read openclaw.json from workspace service
        const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
        const openclawConfig = JSON.parse(configData.content);
        const agentsList = openclawConfig?.agents?.list || [];

        // Create a map of agent_id -> agent config
        const agentConfigMap = new Map();
        agentsList.forEach((agent) => {
          if (agent.id) {
            agentConfigMap.set(agent.id, agent);
          }
        });

        // Merge agent config into user objects (agent or admin; admin can also have agent config)
        users = users.map((user) => {
          if ((user.role === 'agent' || user.role === 'admin') && user.agent_id) {
            const agentConfig = agentConfigMap.get(user.agent_id);
            if (agentConfig) {
              return {
                ...user,
                agentConfig: {
                  id: agentConfig.id,
                  workspace: agentConfig.workspace,
                  identity: agentConfig.identity,
                  model: agentConfig.model,
                  default: agentConfig.default,
                  subagents: agentConfig.subagents,
                  heartbeat: agentConfig.heartbeat,
                },
              };
            }
          }
          return user;
        });
      } catch (configError) {
        // If OpenClaw config can't be read, log warning but continue with users data
        logger.warn('Failed to read OpenClaw config for agent merge', {
          error: configError.message,
          status: configError.status,
        });
      }
    }

    res.json({
      data: users,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: total,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/users/:id - Get a single user by ID (all authenticated users can view)
router.get('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { includeAgentConfig } = req.query;

    const result = await pool.query(
      'SELECT id, name, email, avatar_url, role, agent_id, active, created_at, updated_at FROM users WHERE id = $1',
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }

    let user = result.rows[0];

    // If includeAgentConfig is requested and user is an agent or admin with agent_id, merge OpenClaw config
    if (
      includeAgentConfig === 'true' &&
      (user.role === 'agent' || user.role === 'admin') &&
      user.agent_id
    ) {
      try {
        const { makeOpenClawRequest } = require('../../services/openclawWorkspaceClient');

        // Read openclaw.json from workspace service
        const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
        const openclawConfig = JSON.parse(configData.content);
        const agentsList = openclawConfig?.agents?.list || [];

        // Find matching agent config
        const agentConfig = agentsList.find((agent) => agent.id === user.agent_id);
        if (agentConfig) {
          user = {
            ...user,
            agentConfig: {
              id: agentConfig.id,
              workspace: agentConfig.workspace,
              identity: agentConfig.identity,
              model: agentConfig.model,
              default: agentConfig.default,
              subagents: agentConfig.subagents,
              heartbeat: agentConfig.heartbeat,
            },
          };
        }
      } catch (configError) {
        // If OpenClaw config can't be read, log warning but continue with user data
        logger.warn('Failed to read OpenClaw config for agent merge', {
          error: configError.message,
          status: configError.status,
          userId: id,
        });
      }
    }

    res.json({ data: user });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/admin/users - Create a new user (admin/owner only)
router.post('/', requireManageUsers, async (req, res, next) => {
  try {
    const { name, email, password, role = 'user', avatar_url } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        error: { message: 'Name is required', status: 400 },
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({
        error: { message: 'Valid email is required', status: 400 },
      });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        error: { message: 'Password must be at least 8 characters', status: 400 },
      });
    }

    // Only agent, admin and user roles can be assigned via admin endpoints (not owner)
    const validRoles = ['agent', 'admin', 'user'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({
        error: {
          message: 'Invalid role. Only agent, admin and user roles can be assigned.',
          status: 400,
        },
      });
    }

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: { message: 'Email already exists', status: 409 },
      });
    }

    // Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Create user (default active = true)
    const result = await pool.query(
      `
      INSERT INTO users (name, email, password_hash, role, avatar_url, active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id, name, email, avatar_url, role, active, created_at
    `,
      [name, email, password_hash, role, avatar_url],
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/admin/users/:id - Update a user (admin/owner only)
router.put('/:id', requireManageUsers, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, avatar_url, active } = req.body;

    // Check if user exists and get their role and agent_id
    const existing = await pool.query('SELECT id, role, agent_id FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }

    const targetUser = existing.rows[0];

    // Detect if user is being demoted from agent role
    const wasDemotedFromAgent = targetUser.role === 'agent' && role && role !== 'agent';

    // Admin/Agent cannot edit owner
    if ((req.user.role === 'admin' || req.user.role === 'agent') && targetUser.role === 'owner') {
      logger.warn('Owner protection violation: Admin/Agent attempted to edit owner account', {
        action: 'update_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        target_role: targetUser.role,
        violation_type: 'admin_edit_owner',
      });
      return res.status(403).json({
        error: { message: 'Admins cannot edit the owner account', status: 403 },
      });
    }

    // Owner self-protection: cannot change own role
    if (req.user.role === 'owner' && id === req.user.id && role !== undefined && role !== 'owner') {
      logger.warn('Owner protection violation: Owner attempted to change own role', {
        action: 'update_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        attempted_role: role,
        violation_type: 'owner_change_own_role',
      });
      return res.status(400).json({
        error: { message: 'Owner cannot change their own role', status: 400 },
      });
    }

    // Owner self-protection: cannot deactivate themselves
    if (req.user.role === 'owner' && id === req.user.id && active === false) {
      logger.warn('Owner protection violation: Owner attempted to deactivate own account', {
        action: 'update_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        attempted_active: active,
        violation_type: 'owner_deactivate_self',
      });
      return res.status(400).json({
        error: { message: 'Owner cannot deactivate their own account', status: 400 },
      });
    }

    // Validation
    if (name !== undefined && name.trim().length === 0) {
      return res.status(400).json({
        error: { message: 'Name cannot be empty', status: 400 },
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email !== undefined && !emailRegex.test(email)) {
      return res.status(400).json({
        error: { message: 'Valid email is required', status: 400 },
      });
    }

    if (password !== undefined && password.length < 8) {
      return res.status(400).json({
        error: { message: 'Password must be at least 8 characters', status: 400 },
      });
    }

    // Only agent, admin and user roles can be assigned via admin endpoints (not owner)
    // Exception: owner can keep their own role when updating themselves
    const validRoles = ['agent', 'admin', 'user'];
    if (role !== undefined && !validRoles.includes(role)) {
      // Allow 'owner' role only if target user is already owner
      if (role !== 'owner' || targetUser.role !== 'owner') {
        return res.status(400).json({
          error: {
            message: 'Invalid role. Only agent, admin and user roles can be assigned.',
            status: 400,
          },
        });
      }
    }

    // Prevent deactivating yourself
    if (active === false && id === req.user.id) {
      return res.status(400).json({
        error: { message: 'Cannot deactivate your own account', status: 400 },
      });
    }

    // Check if email is taken by another user
    if (email) {
      const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [
        email,
        id,
      ]);
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({
          error: { message: 'Email already exists', status: 409 },
        });
      }
    }

    // Build dynamic update query
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount}`);
      params.push(name);
      paramCount++;
    }

    if (email !== undefined) {
      updates.push(`email = $${paramCount}`);
      params.push(email);
      paramCount++;
    }

    if (password !== undefined) {
      const saltRounds = 10;
      const password_hash = await bcrypt.hash(password, saltRounds);
      updates.push(`password_hash = $${paramCount}`);
      params.push(password_hash);
      paramCount++;
    }

    if (role !== undefined) {
      updates.push(`role = $${paramCount}`);
      params.push(role);
      paramCount++;
    }

    if (avatar_url !== undefined) {
      updates.push(`avatar_url = $${paramCount}`);
      params.push(avatar_url);
      paramCount++;
    }

    if (active !== undefined) {
      updates.push(`active = $${paramCount}`);
      params.push(active);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: { message: 'No fields to update', status: 400 },
      });
    }

    params.push(id);

    const result = await pool.query(
      `
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, name, email, avatar_url, role, agent_id, active, created_at, updated_at
    `,
      params,
    );

    // If user was demoted from agent role, remove from OpenClaw config
    if (wasDemotedFromAgent && targetUser.agent_id) {
      try {
        await removeAgentFromConfig(targetUser.agent_id);
        logger.info('Removed agent from OpenClaw config after demotion', {
          userId: id,
          agentId: targetUser.agent_id,
          oldRole: 'agent',
          newRole: role,
        });
      } catch (removeError) {
        // Log error but don't fail the user update
        logger.warn('Failed to remove agent from OpenClaw config', {
          error: removeError.message,
          userId: id,
          agentId: targetUser.agent_id,
        });
      }
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/admin/users/:id/agent - Upsert agent configuration (owner/admin only)
router.put('/:id/agent', requireManageUsers, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { agentId, agentConfigPatch } = req.body;

    // Check if user exists and get their role
    const userResult = await pool.query(
      'SELECT id, role, agent_id, name, email FROM users WHERE id = $1',
      [id],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: { message: 'User not found', status: 404 },
      });
    }

    const user = userResult.rows[0];

    // User must have role 'agent' or 'admin' to have agent config (an agent can also be an admin)
    if (user.role !== 'agent' && user.role !== 'admin') {
      return res.status(400).json({
        error: {
          message: 'User must have role "agent" or "admin" to configure agent settings',
          status: 400,
        },
      });
    }

    // Validate agentId format (slug: lowercase, alphanumeric, hyphens, underscores)
    const agentIdSlug = agentId || user.agent_id;
    if (!agentIdSlug) {
      return res.status(400).json({
        error: {
          message: 'agentId is required when configuring agent',
          status: 400,
        },
      });
    }

    const slugRegex = /^[a-z0-9_-]+$/;
    if (!slugRegex.test(agentIdSlug)) {
      return res.status(400).json({
        error: {
          message: 'agentId must be a valid slug (lowercase, alphanumeric, hyphens, underscores)',
          status: 400,
        },
      });
    }

    // If agentId is being changed, check if it's already taken by another user
    if (agentId && agentId !== user.agent_id) {
      const existingAgent = await pool.query(
        'SELECT id FROM users WHERE agent_id = $1 AND id != $2',
        [agentId, id],
      );
      if (existingAgent.rows.length > 0) {
        return res.status(409).json({
          error: {
            message: 'agentId is already in use by another user',
            status: 409,
          },
        });
      }
    }

    const { makeOpenClawRequest } = require('../../services/openclawWorkspaceClient');

    // Read openclaw.json
    let openclawConfig;
    try {
      const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      openclawConfig = JSON.parse(configData.content);
    } catch (readError) {
      logger.error('Failed to read OpenClaw config', {
        error: readError.message,
        userId: id,
      });
      return res.status(500).json({
        error: {
          message: 'Failed to read OpenClaw configuration',
          status: 500,
        },
      });
    }

    // Ensure agents.list exists
    if (!openclawConfig.agents) {
      openclawConfig.agents = {};
    }
    if (!openclawConfig.agents.list) {
      openclawConfig.agents.list = [];
    }

    // Find or create agent entry
    let agentEntry = openclawConfig.agents.list.find((a) => a.id === agentIdSlug);
    const isNewAgent = !agentEntry;

    if (isNewAgent) {
      // Create new agent entry with defaults
      agentEntry = {
        id: agentIdSlug,
        workspace: `/home/node/.openclaw/workspace-${agentIdSlug}`,
        identity: {
          name: user.name,
          theme: `${user.name} workspace`,
          emoji: '🤖',
        },
        model: {
          primary: 'openrouter/moonshotai/kimi-k2.5',
          fallbacks: [],
        },
        default: false,
      };
      openclawConfig.agents.list.push(agentEntry);
    }

    // Apply agentConfigPatch if provided
    if (agentConfigPatch && typeof agentConfigPatch === 'object') {
      // Merge identity fields
      if (agentConfigPatch.identity) {
        agentEntry.identity = {
          ...agentEntry.identity,
          ...agentConfigPatch.identity,
        };
      }

      // Merge model fields
      if (agentConfigPatch.model) {
        agentEntry.model = {
          ...agentEntry.model,
          ...agentConfigPatch.model,
        };
      }

      // Merge other allowed fields
      const allowedFields = ['default', 'subagents', 'heartbeat', 'workspace'];
      allowedFields.forEach((field) => {
        if (agentConfigPatch[field] !== undefined) {
          agentEntry[field] = agentConfigPatch[field];
        }
      });
    }

    // Update meta timestamp
    if (!openclawConfig.meta) {
      openclawConfig.meta = {};
    }
    openclawConfig.meta.lastTouchedAt = new Date().toISOString();

    // Write openclaw.json back
    try {
      await makeOpenClawRequest('PUT', '/files', {
        path: '/openclaw.json',
        content: JSON.stringify(openclawConfig, null, 2),
        encoding: 'utf8',
      });
    } catch (writeError) {
      logger.error('Failed to write OpenClaw config', {
        error: writeError.message,
        userId: id,
      });
      return res.status(500).json({
        error: {
          message: 'Failed to update OpenClaw configuration',
          status: 500,
        },
      });
    }

    // Update user's agent_id in database if changed
    if (agentId && agentId !== user.agent_id) {
      await pool.query('UPDATE users SET agent_id = $1 WHERE id = $2', [agentId, id]);
    }

    // Scaffold workspace files if this is a new agent
    if (isNewAgent) {
      try {
        const workspacePath = agentEntry.workspace.replace('/home/node/.openclaw/', '/');
        await scaffoldAgentWorkspace(agentIdSlug, workspacePath, user.name);

        logger.info('Scaffolded workspace for new agent', {
          agentId: agentIdSlug,
          workspacePath,
          userId: id,
        });
      } catch (scaffoldError) {
        // Log error but don't fail the request - workspace can be scaffolded later
        logger.warn('Failed to scaffold agent workspace', {
          error: scaffoldError.message,
          agentId: agentIdSlug,
          userId: id,
        });
      }
    }

    res.json({
      data: {
        userId: id,
        agentId: agentIdSlug,
        agentConfig: agentEntry,
        created: isNewAgent,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Helper function to scaffold agent workspace files
async function scaffoldAgentWorkspace(agentId, workspacePath, agentName) {
  const { makeOpenClawRequest } = require('../../services/openclawWorkspaceClient');

  // Template files to create
  const templates = [
    {
      name: 'AGENTS.md',
      content: `# ${agentName} - Agent Workspace

This workspace belongs to ${agentName}, agent ID: ${agentId}.

## Purpose

[Describe the agent's purpose and responsibilities here]

## Capabilities

- [List key capabilities]
- [Add more as needed]

## Context

This agent operates within the MosBot ecosystem and has access to shared tools and resources.
`,
    },
    {
      name: 'SOUL.md',
      content: `# ${agentName} - Core Identity

## Personality

[Define the agent's personality and communication style]

## Values

- [List core values]
- [Add more as needed]

## Approach

[Describe how this agent approaches tasks and decision-making]
`,
    },
    {
      name: 'IDENTITY.md',
      content: `# ${agentName} Identity

**Agent ID:** ${agentId}
**Name:** ${agentName}

## Role

[Define the agent's role in the organization]

## Responsibilities

- [List key responsibilities]
- [Add more as needed]
`,
    },
    {
      name: 'USER.md',
      content: `# User Context for ${agentName}

This file contains information about the users this agent interacts with.

## Primary Users

[List primary users and their needs]

## Interaction Guidelines

[Define how the agent should interact with different user types]
`,
    },
    {
      name: 'MEMORY.md',
      content: `# ${agentName} Memory

This file stores persistent memory and learned context.

## Key Facts

[Record important facts and learnings]

## History

[Track significant events and decisions]
`,
    },
    {
      name: 'TOOLS.md',
      content: `# ${agentName} Tools

## Available Tools

This agent has access to the standard MosBot toolkit:

- File system operations
- Database queries
- API integrations
- Communication channels

## Custom Tools

[Document any agent-specific tools or capabilities]
`,
    },
  ];

  // Try to create each template file (create-only, skip if exists)
  for (const template of templates) {
    const filePath = `${workspacePath}/${template.name}`;

    try {
      // Check if file exists
      try {
        await makeOpenClawRequest('GET', `/files/content?path=${encodeURIComponent(filePath)}`);
        // File exists, skip
        logger.info('Workspace file already exists, skipping', { filePath });
        continue;
      } catch (checkError) {
        // File doesn't exist (404), proceed to create
        if (checkError.status !== 404) {
          throw checkError;
        }
      }

      // Create file
      await makeOpenClawRequest('POST', '/files', {
        path: filePath,
        content: template.content,
        encoding: 'utf8',
      });

      logger.info('Created workspace file', { filePath });
    } catch (fileError) {
      logger.warn('Failed to create workspace file', {
        filePath,
        error: fileError.message,
      });
      // Continue with other files
    }
  }
}

// Helper function to remove agent from OpenClaw config (keeps workspace folder)
async function removeAgentFromConfig(agentId) {
  const { makeOpenClawRequest } = require('../../services/openclawWorkspaceClient');

  // Read openclaw.json
  const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
  const openclawConfig = JSON.parse(configData.content);

  // Remove agent from list
  if (openclawConfig.agents && openclawConfig.agents.list) {
    const originalLength = openclawConfig.agents.list.length;
    openclawConfig.agents.list = openclawConfig.agents.list.filter((agent) => agent.id !== agentId);

    if (openclawConfig.agents.list.length === originalLength) {
      // Agent not found in config, nothing to do
      logger.info('Agent not found in OpenClaw config', { agentId });
      return;
    }

    // Update meta timestamp
    if (!openclawConfig.meta) {
      openclawConfig.meta = {};
    }
    openclawConfig.meta.lastTouchedAt = new Date().toISOString();

    // Write updated config back
    await makeOpenClawRequest('PUT', '/files', {
      path: '/openclaw.json',
      content: JSON.stringify(openclawConfig, null, 2),
      encoding: 'utf8',
    });

    logger.info('Removed agent from OpenClaw config', { agentId });
  }
}

// DELETE /api/v1/admin/users/:id - Delete a user (admin/owner only)
router.delete('/:id', requireManageUsers, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;

    // Prevent deleting yourself
    if (id === req.user.id) {
      return res.status(400).json({
        error: { message: 'Cannot delete your own account', status: 400 },
      });
    }

    // Check target user's role and agent_id
    const targetUser = await pool.query('SELECT role, agent_id FROM users WHERE id = $1', [id]);
    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }

    const user = targetUser.rows[0];

    // Owner cannot be deleted by anyone
    if (user.role === 'owner') {
      logger.warn('Owner protection violation: Attempted to delete owner account', {
        action: 'delete_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        target_role: user.role,
        violation_type: 'delete_owner',
      });
      return res.status(403).json({
        error: { message: 'Owner account cannot be deleted', status: 403 },
      });
    }

    // Admin/Agent cannot delete owner
    if ((req.user.role === 'admin' || req.user.role === 'agent') && user.role === 'owner') {
      logger.warn('Owner protection violation: Admin/Agent attempted to delete owner account', {
        action: 'delete_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        target_role: user.role,
        violation_type: 'admin_delete_owner',
      });
      return res.status(403).json({
        error: { message: 'Admins cannot delete the owner account', status: 403 },
      });
    }

    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }

    // If deleted user was an agent, remove from OpenClaw config
    if (user.role === 'agent' && user.agent_id) {
      try {
        await removeAgentFromConfig(user.agent_id);
        logger.info('Removed agent from OpenClaw config after deletion', {
          userId: id,
          agentId: user.agent_id,
        });
      } catch (removeError) {
        // Log error but don't fail the delete
        logger.warn('Failed to remove agent from OpenClaw config', {
          error: removeError.message,
          userId: id,
          agentId: user.agent_id,
        });
      }
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
