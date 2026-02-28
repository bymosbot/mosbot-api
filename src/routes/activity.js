const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const { authenticateToken, requireAdmin } = require('./auth');

const VALID_EVENT_TYPES = new Set([
  'task_executed',
  'cron_run',
  'heartbeat_run',
  'heartbeat_attention',
  'adhoc_request',
  'subagent_request',
  'subagent_completed',
  'workspace_file_created',
  'workspace_file_updated',
  'workspace_file_deleted',
  'org_chart_agent_updated',
  'org_chart_agent_created',
  'cron_job_created',
  'cron_job_updated',
  'cron_job_deleted',
  'cron_job_triggered',
  'legacy',
  'system',
]);

const VALID_SEVERITIES = new Set(['info', 'warning', 'attention', 'error']);

const VALID_SOURCES = new Set([
  'task',
  'cron',
  'heartbeat',
  'subagent',
  'workspace',
  'org',
  'standup',
  'system',
]);

/**
 * Build a `links` object for a row so the dashboard can render clickthrough pills.
 * All fields are optional — only include what's available.
 */
function buildLinks(row) {
  const links = {};
  if (row.task_id) {
    links.task = { href: `/task/${row.task_id}`, label: row.task_title || 'View Task' };
  }
  if (row.session_key) {
    links.session = {
      href: `/monitor?sessionKey=${encodeURIComponent(row.session_key)}`,
      label: 'Agent Monitor',
    };
  }
  if (row.job_id) {
    links.job = { href: `/scheduler?jobId=${encodeURIComponent(row.job_id)}`, label: 'Scheduler' };
  }
  if (row.workspace_path) {
    if (row.workspace_path.startsWith('/shared/projects')) {
      links.workspace = { href: '/projects', label: 'Projects' };
    } else {
      links.workspace = { href: '/workspaces', label: 'Workspace' };
    }
  }
  return Object.keys(links).length ? links : undefined;
}

// Middleware to validate UUID
const validateUUID = (paramName) => (req, res, next) => {
  const id = req.params[paramName];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: { message: 'Invalid UUID format', status: 400 } });
  }
  next();
};

// GET /api/v1/activity/feed - Unified feed from activity_logs table only
// Must be registered before /:id to avoid route collision.
router.get('/feed', async (req, res, next) => {
  try {
    const {
      event_type,
      severity,
      source,
      category,
      agent_id,
      task_id,
      job_id,
      session_key,
      limit = 50,
      offset = 0,
      start_date,
      end_date,
    } = req.query;

    const limitNum = Math.max(1, Math.min(parseInt(limit) || 50, 500));
    const offsetNum = Math.max(0, parseInt(offset) || 0);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (task_id && !uuidRegex.test(task_id)) {
      return res
        .status(400)
        .json({ error: { message: 'Invalid UUID format for task_id', status: 400 } });
    }

    const params = [];
    let p = 1;

    let query = `
      SELECT
        al.id,
        al.timestamp,
        al.title,
        al.description,
        al.category,
        al.event_type,
        al.severity,
        al.source,
        al.agent_id,
        al.task_id,
        al.job_id,
        al.session_key,
        al.run_id,
        al.workspace_path,
        al.meta,
        al.actor_user_id,
        al.created_at,
        t.title       AS task_title,
        u.name        AS agent_name,
        u.avatar_url  AS agent_avatar,
        au.name       AS actor_name
      FROM activity_logs al
      LEFT JOIN tasks t  ON t.id = al.task_id
      LEFT JOIN users u  ON u.agent_id = al.agent_id
      LEFT JOIN users au ON au.id = al.actor_user_id
      WHERE 1=1
    `;

    if (event_type) {
      query += ` AND al.event_type = $${p++}`;
      params.push(event_type);
    }
    if (severity) {
      query += ` AND al.severity = $${p++}`;
      params.push(severity);
    }
    if (source) {
      query += ` AND al.source = $${p++}`;
      params.push(source);
    }
    if (category) {
      query += ` AND al.category = $${p++}`;
      params.push(category);
    }
    if (agent_id) {
      query += ` AND al.agent_id = $${p++}`;
      params.push(agent_id);
    }
    if (task_id) {
      query += ` AND al.task_id = $${p++}`;
      params.push(task_id);
    }
    if (job_id) {
      query += ` AND al.job_id = $${p++}`;
      params.push(job_id);
    }
    if (session_key) {
      query += ` AND al.session_key = $${p++}`;
      params.push(session_key);
    }
    if (start_date) {
      query += ` AND al.timestamp >= $${p++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND al.timestamp <= $${p++}`;
      params.push(end_date);
    }

    const countQuery = query.replace(
      /SELECT[\s\S]+?FROM activity_logs/,
      'SELECT COUNT(*) AS total FROM activity_logs',
    );

    query += ` ORDER BY al.timestamp DESC LIMIT $${p++} OFFSET $${p++}`;
    params.push(limitNum, offsetNum);

    const countParams = params.slice(0, params.length - 2);
    const [result, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams),
    ]);

    const data = result.rows.map((row) => ({
      ...row,
      links: buildLinks(row),
    }));

    res.json({
      data,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: parseInt(countResult.rows[0].total, 10),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/activity - List all activity logs with optional filtering
router.get('/', async (req, res, next) => {
  try {
    const {
      category,
      agent_id,
      task_id,
      limit = 100,
      offset = 0,
      start_date,
      end_date,
    } = req.query;

    const limitNum = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetNum = Math.max(0, parseInt(offset) || 0);

    if (task_id) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(task_id)) {
        return res
          .status(400)
          .json({ error: { message: 'Invalid UUID format for task_id', status: 400 } });
      }
    }

    let query = `
      SELECT
        al.id,
        al.timestamp,
        al.title,
        al.description,
        al.category,
        al.agent_id,
        al.task_id,
        al.created_at,
        t.title AS task_title,
        u.name  AS agent_name
      FROM activity_logs al
      LEFT JOIN tasks t ON t.id = al.task_id
      LEFT JOIN users u ON u.agent_id = al.agent_id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (category) {
      query += ` AND al.category = $${paramCount}`;
      params.push(category);
      paramCount++;
    }

    if (agent_id) {
      query += ` AND al.agent_id = $${paramCount}`;
      params.push(agent_id);
      paramCount++;
    }

    if (task_id) {
      query += ` AND al.task_id = $${paramCount}`;
      params.push(task_id);
      paramCount++;
    }

    if (start_date) {
      query += ` AND al.timestamp >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }

    if (end_date) {
      query += ` AND al.timestamp <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    query += ` ORDER BY al.timestamp DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limitNum, offsetNum);

    const result = await pool.query(query, params);

    res.json({
      data: result.rows,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: result.rowCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/activity/:id - Get a single activity log by ID
router.get('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
         al.id, al.timestamp, al.title, al.description,
         al.category, al.agent_id, al.task_id, al.created_at,
         t.title AS task_title,
         u.name  AS agent_name
       FROM activity_logs al
       LEFT JOIN tasks t ON t.id = al.task_id
       LEFT JOIN users u ON u.agent_id = al.agent_id
       WHERE al.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Activity log not found', status: 404 } });
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/activity - Create a new activity log
router.post('/', async (req, res, next) => {
  try {
    const {
      title,
      description,
      category,
      agent_id,
      task_id,
      timestamp,
      event_type,
      severity,
      source,
      actor_user_id,
      job_id,
      session_key,
      run_id,
      workspace_path,
      meta,
      dedupe_key,
    } = req.body;

    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Title is required', status: 400 } });
    }

    if (!description || description.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Description is required', status: 400 } });
    }

    if (title.length > 500) {
      return res
        .status(400)
        .json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }

    if (event_type && !VALID_EVENT_TYPES.has(event_type)) {
      return res
        .status(400)
        .json({ error: { message: `Invalid event_type: ${event_type}`, status: 400 } });
    }

    if (severity && !VALID_SEVERITIES.has(severity)) {
      return res
        .status(400)
        .json({ error: { message: `Invalid severity: ${severity}`, status: 400 } });
    }

    if (source && !VALID_SOURCES.has(source)) {
      return res.status(400).json({ error: { message: `Invalid source: ${source}`, status: 400 } });
    }

    const result = await pool.query(
      `
      INSERT INTO activity_logs (
        title, description, category, agent_id, task_id, timestamp,
        event_type, severity, source, actor_user_id,
        job_id, session_key, run_id, workspace_path, meta, dedupe_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING *
    `,
      [
        title,
        description,
        category || null,
        agent_id || null,
        task_id || null,
        timestamp || new Date(),
        event_type || 'system',
        severity || 'info',
        source || 'system',
        actor_user_id || null,
        job_id || null,
        session_key || null,
        run_id || null,
        workspace_path || null,
        meta ? JSON.stringify(meta) : null,
        dedupe_key || null,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ data: null, deduplicated: true });
    }

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/activity/:id - Update an activity log
router.put('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, category, agent_id, task_id, timestamp } = req.body;

    const existing = await pool.query('SELECT id FROM activity_logs WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Activity log not found', status: 404 } });
    }

    if (title !== undefined && title.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Title cannot be empty', status: 400 } });
    }

    if (description !== undefined && description.trim().length === 0) {
      return res
        .status(400)
        .json({ error: { message: 'Description cannot be empty', status: 400 } });
    }

    if (title && title.length > 500) {
      return res
        .status(400)
        .json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }

    const updates = [];
    const params = [];
    let paramCount = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramCount}`);
      params.push(title);
      paramCount++;
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      params.push(description);
      paramCount++;
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount}`);
      params.push(category);
      paramCount++;
    }
    if (agent_id !== undefined) {
      updates.push(`agent_id = $${paramCount}`);
      params.push(agent_id);
      paramCount++;
    }
    if (task_id !== undefined) {
      updates.push(`task_id = $${paramCount}`);
      params.push(task_id);
      paramCount++;
    }
    if (timestamp !== undefined) {
      updates.push(`timestamp = $${paramCount}`);
      params.push(timestamp);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
    }

    params.push(id);

    const result = await pool.query(
      `
      UPDATE activity_logs
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `,
      params,
    );

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/activity/:id - Partial update an activity log
router.patch('/:id', validateUUID('id'), async (req, res, next) => {
  req.method = 'PUT';
  return router.handle(req, res, next);
});

// DELETE /api/v1/activity/:id - Delete an activity log
router.delete('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM activity_logs WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Activity log not found', status: 404 } });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/activity/reset - Reset all activity logs (admin only, requires password confirmation)
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
    const countResult = await pool.query('SELECT COUNT(*) AS total FROM activity_logs');
    const deletedCount = parseInt(countResult.rows[0].total, 10);

    // Delete all activity logs
    await pool.query('DELETE FROM activity_logs');

    // Reset sequence if using auto-increment (optional, depending on table setup)
    // await pool.query('ALTER SEQUENCE activity_logs_id_seq RESTART WITH 1');

    res.json({
      data: {
        success: true,
        deletedCount,
        message: `All activity logs have been permanently deleted (${deletedCount} entries)`,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
