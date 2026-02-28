const express = require('express');
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const { authenticateToken, requireAdmin } = require('./auth');
const logger = require('../utils/logger');
const { makeOpenClawRequest } = require('../services/openclawWorkspaceClient');

const router = express.Router();

const VALID_STATUS = ['running', 'completed', 'error'];
const VALID_MESSAGE_KINDS = ['agent', 'system'];

const validateUUID = (paramName) => (req, res, next) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(req.params[paramName])) {
    return res
      .status(400)
      .json({ error: { message: `Invalid UUID for parameter '${paramName}'`, status: 400 } });
  }
  next();
};

// ---------------------------------------------------------------------------
// GET /api/v1/standups
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;

    logger.info('Fetching standups list', { userId: req.user.id, limit, offset });

    const result = await pool.query(
      `SELECT
        s.id,
        s.standup_date,
        s.title,
        s.timezone,
        s.status,
        s.started_at,
        s.completed_at,
        s.created_at,
        s.updated_at,
        COUNT(se.id)::int AS entry_count,
        ARRAY_AGG(
          JSON_BUILD_OBJECT(
            'agent_id',    se.agent_id,
            'user_id',     se.user_id,
            'user_name',   COALESCE(u_uid.name, u_aid.name),
            'avatar_url',  COALESCE(u_uid.avatar_url, u_aid.avatar_url)
          ) ORDER BY se.turn_order
        ) FILTER (WHERE se.id IS NOT NULL) AS participants
      FROM standups s
      LEFT JOIN standup_entries se ON s.id = se.standup_id
      LEFT JOIN users u_uid ON se.user_id = u_uid.id
      LEFT JOIN users u_aid ON se.agent_id = u_aid.agent_id
      GROUP BY s.id
      ORDER BY s.standup_date DESC, s.created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM standups');
    const total = countResult.rows[0]?.total || 0;

    res.json({
      data: result.rows,
      pagination: { limit, offset, total },
    });
  } catch (error) {
    logger.error('Failed to fetch standups list', { userId: req.user.id, error: error.message });
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/standups/latest
// ---------------------------------------------------------------------------
router.get('/latest', authenticateToken, async (req, res, next) => {
  try {
    logger.info('Fetching latest standup', { userId: req.user.id });

    const result = await pool.query(
      `SELECT
        s.id,
        s.standup_date,
        s.title,
        s.timezone,
        s.status,
        s.started_at,
        s.completed_at,
        s.created_at,
        s.updated_at,
        COUNT(se.id)::int AS entry_count,
        ARRAY_AGG(
          JSON_BUILD_OBJECT(
            'agent_id',    se.agent_id,
            'user_id',     se.user_id,
            'user_name',   COALESCE(u_uid.name, u_aid.name),
            'avatar_url',  COALESCE(u_uid.avatar_url, u_aid.avatar_url)
          ) ORDER BY se.turn_order
        ) FILTER (WHERE se.id IS NOT NULL) AS participants
      FROM standups s
      LEFT JOIN standup_entries se ON s.id = se.standup_id
      LEFT JOIN users u_uid ON se.user_id = u_uid.id
      LEFT JOIN users u_aid ON se.agent_id = u_aid.agent_id
      GROUP BY s.id
      ORDER BY s.standup_date DESC, s.created_at DESC
      LIMIT 1`,
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'No standups found', status: 404 } });
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    logger.error('Failed to fetch latest standup', { userId: req.user.id, error: error.message });
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/standups  (admin)
// ---------------------------------------------------------------------------
router.post('/', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { standup_date, title, timezone, status, started_at, completed_at } = req.body;

    if (!standup_date || String(standup_date).trim() === '') {
      return res.status(400).json({ error: { message: 'standup_date is required', status: 400 } });
    }
    if (!title || String(title).trim() === '') {
      return res.status(400).json({ error: { message: 'title is required', status: 400 } });
    }
    if (!timezone || String(timezone).trim() === '') {
      return res.status(400).json({ error: { message: 'timezone is required', status: 400 } });
    }
    const resolvedStatus = status || 'running';
    if (!VALID_STATUS.includes(resolvedStatus)) {
      return res.status(400).json({
        error: { message: `status must be one of: ${VALID_STATUS.join(', ')}`, status: 400 },
      });
    }

    logger.info('Creating standup', { userId: req.user.id, standup_date, status: resolvedStatus });

    const result = await pool.query(
      `INSERT INTO standups (standup_date, title, timezone, status, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        standup_date,
        title.trim(),
        timezone.trim(),
        resolvedStatus,
        started_at || null,
        completed_at || null,
      ],
    );

    logger.info('Standup created', { userId: req.user.id, standupId: result.rows[0].id });
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: { message: 'A standup for this date already exists', status: 409 },
      });
    }
    logger.error('Failed to create standup', { userId: req.user.id, error: error.message });
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/standups/:id
// ---------------------------------------------------------------------------
router.get('/:id', authenticateToken, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;

    logger.info('Fetching standup detail', { userId: req.user.id, standupId: id });

    const standupResult = await pool.query(
      `SELECT id, standup_date, title, timezone, status, started_at, completed_at, created_at, updated_at
       FROM standups WHERE id = $1`,
      [id],
    );

    if (standupResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
    }

    const standup = standupResult.rows[0];

    const entriesResult = await pool.query(
      `SELECT
        se.id,
        se.standup_id,
        se.agent_id,
        se.user_id,
        COALESCE(u_uid.name, u_aid.name)           AS user_name,
        COALESCE(u_uid.avatar_url, u_aid.avatar_url) AS avatar_url,
        se.turn_order,
        se.yesterday,
        se.today,
        se.blockers,
        se.tasks,
        se.raw,
        se.created_at
      FROM standup_entries se
      LEFT JOIN users u_uid ON se.user_id = u_uid.id
      LEFT JOIN users u_aid ON se.agent_id = u_aid.agent_id
      WHERE se.standup_id = $1
      ORDER BY se.turn_order ASC`,
      [id],
    );

    // Enrich entries with agent title from openclaw.json (identity.title)
    let agentTitleMap = new Map();
    try {
      const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      const config = JSON.parse(configData.content);
      (config?.agents?.list || []).forEach((agent) => {
        if (agent.id && agent.identity?.title) {
          agentTitleMap.set(agent.id, agent.identity.title);
        }
      });
    } catch (configErr) {
      logger.warn('Could not read openclaw.json for agent titles in standup detail', {
        error: configErr.message,
      });
    }

    const enrichedEntries = entriesResult.rows.map((entry) => ({
      ...entry,
      agent_title: entry.agent_id ? agentTitleMap.get(entry.agent_id) || null : null,
    }));

    const messagesResult = await pool.query(
      `SELECT id, standup_id, kind, agent_id, content, created_at
       FROM standup_messages
       WHERE standup_id = $1
         AND kind = 'agent'
       ORDER BY created_at ASC`,
      [id],
    );

    res.json({
      data: {
        ...standup,
        entries: enrichedEntries,
        messages: messagesResult.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch standup detail', {
      userId: req.user.id,
      standupId: req.params.id,
      error: error.message,
    });
    next(error);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/standups/:id  (admin)
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { standup_date, title, timezone, status, started_at, completed_at } = req.body;

      const fields = [];
      const params = [];
      let paramCount = 1;

      if (standup_date !== undefined) {
        fields.push(`standup_date = $${paramCount++}`);
        params.push(standup_date);
      }
      if (title !== undefined) {
        if (String(title).trim() === '') {
          return res.status(400).json({ error: { message: 'title cannot be empty', status: 400 } });
        }
        fields.push(`title = $${paramCount++}`);
        params.push(title.trim());
      }
      if (timezone !== undefined) {
        if (String(timezone).trim() === '') {
          return res
            .status(400)
            .json({ error: { message: 'timezone cannot be empty', status: 400 } });
        }
        fields.push(`timezone = $${paramCount++}`);
        params.push(timezone.trim());
      }
      if (status !== undefined) {
        if (!VALID_STATUS.includes(status)) {
          return res.status(400).json({
            error: { message: `status must be one of: ${VALID_STATUS.join(', ')}`, status: 400 },
          });
        }
        fields.push(`status = $${paramCount++}`);
        params.push(status);
      }
      if (started_at !== undefined) {
        fields.push(`started_at = $${paramCount++}`);
        params.push(started_at);
      }
      if (completed_at !== undefined) {
        fields.push(`completed_at = $${paramCount++}`);
        params.push(completed_at);
      }

      if (fields.length === 0) {
        return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
      }

      params.push(id);

      logger.info('Updating standup', { userId: req.user.id, standupId: id, fields });

      const result = await pool.query(
        `UPDATE standups SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        params,
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
      }

      logger.info('Standup updated', { userId: req.user.id, standupId: id });
      res.json({ data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error: { message: 'A standup for this date already exists', status: 409 },
        });
      }
      logger.error('Failed to update standup', {
        userId: req.user.id,
        standupId: req.params.id,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/v1/standups/:id  (admin)
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      logger.info('Deleting standup', { userId: req.user.id, standupId: id });

      const result = await pool.query('DELETE FROM standups WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
      }

      logger.info('Standup deleted', { userId: req.user.id, standupId: id });
      res.status(204).send();
    } catch (error) {
      logger.error('Failed to delete standup', {
        userId: req.user.id,
        standupId: req.params.id,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/standups/:id/run  (admin)
// Conduct a standup: call OpenClaw sessions_send for each agent in canonical
// order, write entries + messages, transition status.
// ---------------------------------------------------------------------------
router.post(
  '/:id/run',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      logger.info('Running standup collection', { userId: req.user.id, standupId: id });

      const standupResult = await pool.query('SELECT * FROM standups WHERE id = $1', [id]);

      if (standupResult.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
      }

      const standup = standupResult.rows[0];

      const { runStandupById } = require('../services/standupService');
      const result = await runStandupById(standup);

      if (result.status === 'error') {
        logger.error('Standup run failed', { standupId: id, message: result.message });
        return res.status(500).json({
          error: { message: result.message || 'Standup run failed', status: 500 },
        });
      }

      const updated = await pool.query(
        `SELECT id, standup_date, title, timezone, status, started_at, completed_at, created_at, updated_at
       FROM standups WHERE id = $1`,
        [id],
      );

      logger.info('Standup run completed', {
        userId: req.user.id,
        standupId: id,
        agentCount: result.agentCount,
      });
      res.json({ data: updated.rows[0] });
    } catch (error) {
      logger.error('Failed to run standup', {
        userId: req.user.id,
        standupId: req.params.id,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/standups/:id/entries  (authenticated)
// ---------------------------------------------------------------------------
router.get('/:id/entries', authenticateToken, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const standupCheck = await pool.query('SELECT id FROM standups WHERE id = $1', [id]);
    if (standupCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
    }

    const result = await pool.query(
      `SELECT
        se.id,
        se.standup_id,
        se.agent_id,
        se.user_id,
        COALESCE(u_uid.name, u_aid.name)             AS user_name,
        COALESCE(u_uid.avatar_url, u_aid.avatar_url) AS avatar_url,
        se.turn_order,
        se.yesterday,
        se.today,
        se.blockers,
        se.tasks,
        se.raw,
        se.created_at
      FROM standup_entries se
      LEFT JOIN users u_uid ON se.user_id = u_uid.id
      LEFT JOIN users u_aid ON se.agent_id = u_aid.agent_id
      WHERE se.standup_id = $1
      ORDER BY se.turn_order ASC`,
      [id],
    );

    // Enrich with agent titles from openclaw.json
    let agentTitleMap = new Map();
    try {
      const configData = await makeOpenClawRequest('GET', '/files/content?path=/openclaw.json');
      const config = JSON.parse(configData.content);
      (config?.agents?.list || []).forEach((agent) => {
        if (agent.id && agent.identity?.title) {
          agentTitleMap.set(agent.id, agent.identity.title);
        }
      });
    } catch (configErr) {
      logger.warn('Could not read openclaw.json for agent titles in standup entries', {
        error: configErr.message,
      });
    }

    const enrichedRows = result.rows.map((entry) => ({
      ...entry,
      agent_title: entry.agent_id ? agentTitleMap.get(entry.agent_id) || null : null,
    }));

    res.json({ data: enrichedRows });
  } catch (error) {
    logger.error('Failed to fetch standup entries', {
      userId: req.user.id,
      standupId: req.params.id,
      error: error.message,
    });
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/standups/:id/entries  (admin)
// ---------------------------------------------------------------------------
router.post(
  '/:id/entries',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { agent_id, user_id, turn_order, yesterday, today, blockers, tasks, raw } = req.body;

      if (!agent_id || String(agent_id).trim() === '') {
        return res.status(400).json({ error: { message: 'agent_id is required', status: 400 } });
      }
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        return res.status(400).json({ error: { message: 'raw is required', status: 400 } });
      }
      if (
        turn_order !== undefined &&
        (isNaN(parseInt(turn_order, 10)) || parseInt(turn_order, 10) < 1)
      ) {
        return res
          .status(400)
          .json({ error: { message: 'turn_order must be a positive integer', status: 400 } });
      }

      const standupCheck = await pool.query('SELECT id FROM standups WHERE id = $1', [id]);
      if (standupCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
      }

      const resolvedTurnOrder = turn_order !== undefined ? parseInt(turn_order, 10) : null;

      const tasksValue =
        tasks !== undefined ? (typeof tasks === 'string' ? tasks : JSON.stringify(tasks)) : null;

      const result = await pool.query(
        `INSERT INTO standup_entries (
         standup_id, agent_id, user_id, turn_order,
         yesterday, today, blockers, tasks, raw
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
        [
          id,
          agent_id.trim(),
          user_id || null,
          resolvedTurnOrder,
          yesterday || null,
          today || null,
          blockers || null,
          tasksValue,
          raw.trim(),
        ],
      );

      logger.info('Standup entry created', {
        userId: req.user.id,
        standupId: id,
        entryId: result.rows[0].id,
      });
      res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to create standup entry', {
        userId: req.user.id,
        standupId: req.params.id,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/v1/standups/:id/entries/:entryId  (admin)
// ---------------------------------------------------------------------------
router.patch(
  '/:id/entries/:entryId',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  validateUUID('entryId'),
  async (req, res, next) => {
    try {
      const { id, entryId } = req.params;
      const { agent_id, user_id, turn_order, yesterday, today, blockers, tasks, raw } = req.body;

      const entryCheck = await pool.query(
        'SELECT id FROM standup_entries WHERE id = $1 AND standup_id = $2',
        [entryId, id],
      );
      if (entryCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Standup entry not found', status: 404 } });
      }

      const fields = [];
      const params = [];
      let paramCount = 1;

      if (agent_id !== undefined) {
        if (String(agent_id).trim() === '') {
          return res
            .status(400)
            .json({ error: { message: 'agent_id cannot be empty', status: 400 } });
        }
        fields.push(`agent_id = $${paramCount++}`);
        params.push(agent_id.trim());
      }
      if (user_id !== undefined) {
        fields.push(`user_id = $${paramCount++}`);
        params.push(user_id || null);
      }
      if (turn_order !== undefined) {
        if (isNaN(parseInt(turn_order, 10)) || parseInt(turn_order, 10) < 1) {
          return res
            .status(400)
            .json({ error: { message: 'turn_order must be a positive integer', status: 400 } });
        }
        fields.push(`turn_order = $${paramCount++}`);
        params.push(parseInt(turn_order, 10));
      }
      if (yesterday !== undefined) {
        fields.push(`yesterday = $${paramCount++}`);
        params.push(yesterday || null);
      }
      if (today !== undefined) {
        fields.push(`today = $${paramCount++}`);
        params.push(today || null);
      }
      if (blockers !== undefined) {
        fields.push(`blockers = $${paramCount++}`);
        params.push(blockers || null);
      }
      if (tasks !== undefined) {
        const tasksValue = typeof tasks === 'string' ? tasks : JSON.stringify(tasks);
        fields.push(`tasks = $${paramCount++}`);
        params.push(tasksValue || null);
      }
      if (raw !== undefined) {
        if (String(raw).trim() === '') {
          return res.status(400).json({ error: { message: 'raw cannot be empty', status: 400 } });
        }
        fields.push(`raw = $${paramCount++}`);
        params.push(raw.trim());
      }

      if (fields.length === 0) {
        return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
      }

      params.push(entryId);

      const result = await pool.query(
        `UPDATE standup_entries SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        params,
      );

      logger.info('Standup entry updated', { userId: req.user.id, standupId: id, entryId });
      res.json({ data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to update standup entry', {
        userId: req.user.id,
        standupId: req.params.id,
        entryId: req.params.entryId,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/v1/standups/:id/entries/:entryId  (admin)
// ---------------------------------------------------------------------------
router.delete(
  '/:id/entries/:entryId',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  validateUUID('entryId'),
  async (req, res, next) => {
    try {
      const { id, entryId } = req.params;

      const result = await pool.query(
        'DELETE FROM standup_entries WHERE id = $1 AND standup_id = $2 RETURNING id',
        [entryId, id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Standup entry not found', status: 404 } });
      }

      logger.info('Standup entry deleted', { userId: req.user.id, standupId: id, entryId });
      res.status(204).send();
    } catch (error) {
      logger.error('Failed to delete standup entry', {
        userId: req.user.id,
        standupId: req.params.id,
        entryId: req.params.entryId,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/standups/:id/messages  (authenticated)
// ---------------------------------------------------------------------------
router.get('/:id/messages', authenticateToken, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const standupCheck = await pool.query('SELECT id FROM standups WHERE id = $1', [id]);
    if (standupCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
    }

    const result = await pool.query(
      `SELECT id, standup_id, kind, agent_id, content, created_at
       FROM standup_messages
       WHERE standup_id = $1
       ORDER BY created_at ASC`,
      [id],
    );

    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Failed to fetch standup messages', {
      userId: req.user.id,
      standupId: req.params.id,
      error: error.message,
    });
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/standups/:id/messages  (admin)
// ---------------------------------------------------------------------------
router.post(
  '/:id/messages',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { kind, agent_id, content } = req.body;

      if (!kind || !VALID_MESSAGE_KINDS.includes(kind)) {
        return res.status(400).json({
          error: { message: `kind must be one of: ${VALID_MESSAGE_KINDS.join(', ')}`, status: 400 },
        });
      }
      if (!content || String(content).trim() === '') {
        return res.status(400).json({ error: { message: 'content is required', status: 400 } });
      }

      const standupCheck = await pool.query('SELECT id FROM standups WHERE id = $1', [id]);
      if (standupCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Standup not found', status: 404 } });
      }

      const result = await pool.query(
        `INSERT INTO standup_messages (standup_id, kind, agent_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
        [id, kind, agent_id || null, content.trim()],
      );

      logger.info('Standup message created', {
        userId: req.user.id,
        standupId: id,
        messageId: result.rows[0].id,
      });
      res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to create standup message', {
        userId: req.user.id,
        standupId: req.params.id,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/v1/standups/:id/messages/:messageId  (admin)
// ---------------------------------------------------------------------------
router.delete(
  '/:id/messages/:messageId',
  authenticateToken,
  requireAdmin,
  validateUUID('id'),
  validateUUID('messageId'),
  async (req, res, next) => {
    try {
      const { id, messageId } = req.params;

      const result = await pool.query(
        'DELETE FROM standup_messages WHERE id = $1 AND standup_id = $2 RETURNING id',
        [messageId, id],
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: { message: 'Standup message not found', status: 404 } });
      }

      logger.info('Standup message deleted', { userId: req.user.id, standupId: id, messageId });
      res.status(204).send();
    } catch (error) {
      logger.error('Failed to delete standup message', {
        userId: req.user.id,
        standupId: req.params.id,
        messageId: req.params.messageId,
        error: error.message,
      });
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/standups/reset - Reset all standup data (admin only, requires password confirmation)
// ---------------------------------------------------------------------------
router.post('/reset', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { password } = req.body;
    const userId = req.user.id;

    // Validate password is provided
    if (!password || password.length === 0) {
      return res.status(400).json({
        error: { message: 'Password is required to confirm reset', status: 400 },
      });
    }

    // Verify user's password
    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: { message: 'User not found', status: 401 },
      });
    }

    const isValidPassword = await bcrypt.compare(password, userResult.rows[0].password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        error: { message: 'Invalid password', status: 401 },
      });
    }

    // Count records before deletion for response
    const standupsCountResult = await pool.query('SELECT COUNT(*) AS total FROM standups');
    const entriesCountResult = await pool.query('SELECT COUNT(*) AS total FROM standup_entries');
    const messagesCountResult = await pool.query('SELECT COUNT(*) AS total FROM standup_messages');

    const deletedStandups = parseInt(standupsCountResult.rows[0].total, 10);
    const deletedEntries = parseInt(entriesCountResult.rows[0].total, 10);
    const deletedMessages = parseInt(messagesCountResult.rows[0].total, 10);

    // Delete all standup data (CASCADE will handle related entries and messages)
    await pool.query('DELETE FROM standup_entries');
    await pool.query('DELETE FROM standup_messages');
    await pool.query('DELETE FROM standups');

    logger.info('All standup data reset', {
      userId,
      deletedStandups,
      deletedEntries,
      deletedMessages,
    });

    res.json({
      data: {
        success: true,
        deletedCount: {
          standups: deletedStandups,
          entries: deletedEntries,
          messages: deletedMessages,
          total: deletedStandups + deletedEntries + deletedMessages,
        },
        message: `All standup data has been permanently deleted (${deletedStandups} standups, ${deletedEntries} entries, ${deletedMessages} messages)`,
      },
    });
  } catch (error) {
    logger.error('Failed to reset standup data', { userId: req.user.id, error: error.message });
    next(error);
  }
});

module.exports = router;
