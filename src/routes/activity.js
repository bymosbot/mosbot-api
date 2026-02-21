const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Middleware to validate UUID
const validateUUID = (paramName) => (req, res, next) => {
  const id = req.params[paramName];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: { message: 'Invalid UUID format', status: 400 } });
  }
  next();
};

// GET /api/v1/activity/feed - Unified feed merging activity_logs + cron last-execution entries
// Must be registered before /:id to avoid route collision.
router.get('/feed', async (req, res, next) => {
  try {
    const {
      category,
      agent_id,
      task_id,
      source = 'all',
      limit = 50,
      offset = 0,
      start_date,
      end_date,
    } = req.query;

    const limitNum = Math.max(1, Math.min(parseInt(limit) || 50, 500));
    const offsetNum = Math.max(0, parseInt(offset) || 0);

    let activityRows = [];
    let cronRows = [];

    // --- Activity logs ---
    if (source === 'all' || source === 'activity') {
      let query = `
        SELECT
          al.id,
          'activity' AS source,
          al.timestamp,
          al.title,
          al.description,
          al.category,
          al.agent_id,
          al.task_id,
          t.title AS task_title,
          u.name  AS agent_name,
          u.avatar_url AS agent_avatar
        FROM activity_logs al
        LEFT JOIN tasks t ON t.id = al.task_id
        LEFT JOIN users u ON u.agent_id = al.agent_id
        WHERE 1=1
      `;
      const params = [];
      let p = 1;

      if (category) {
        query += ` AND al.category = $${p++}`;
        params.push(category);
      }
      if (agent_id) {
        query += ` AND al.agent_id = $${p++}`;
        params.push(agent_id);
      }
      if (task_id) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(task_id)) {
          return res.status(400).json({ error: { message: 'Invalid UUID format for task_id', status: 400 } });
        }
        query += ` AND al.task_id = $${p++}`;
        params.push(task_id);
      }
      if (start_date) {
        query += ` AND al.timestamp >= $${p++}`;
        params.push(start_date);
      }
      if (end_date) {
        query += ` AND al.timestamp <= $${p++}`;
        params.push(end_date);
      }

      query += ` ORDER BY al.timestamp DESC`;
      const result = await pool.query(query, params);
      activityRows = result.rows;
    }

    // --- Cron last-execution entries ---
    // session_usage only stores individual run entries (agent:*:cron:*:run:*).
    // We aggregate per parent job key (everything before ":run:"), taking the
    // most recent run per job as the representative feed entry.
    if (source === 'all' || source === 'cron') {
      // Extract parent key: "agent:coo:cron:<jobId>:run:<runId>" -> "agent:coo:cron:<jobId>"
      // Extract agent_key from parent key when the column is empty (older rows).
      let cronQuery = `
        WITH run_entries AS (
          SELECT
            su.*,
            -- derive parent key by stripping ":run:<uuid>" suffix
            CASE
              WHEN su.session_key ~ ':run:[0-9a-f-]+$'
              THEN regexp_replace(su.session_key, ':run:[0-9a-f-]+$', '')
              ELSE su.session_key
            END AS parent_key,
            -- derive agent_key from session_key when column is null
            COALESCE(
              su.agent_key,
              (regexp_match(su.session_key, '^agent:([^:]+):'))[1]
            ) AS resolved_agent_key
          FROM session_usage su
          WHERE su.session_key LIKE 'agent:%:cron:%'
        ),
        latest_per_job AS (
          SELECT DISTINCT ON (parent_key)
            parent_key,
            session_key,
            resolved_agent_key,
            label,
            model,
            tokens_input,
            tokens_output,
            cost_usd,
            last_updated_at
          FROM run_entries
          ORDER BY parent_key, last_updated_at DESC
        )
        SELECT
          lj.parent_key                                    AS id,
          'cron'                                           AS source,
          lj.last_updated_at                               AS timestamp,
          COALESCE(lj.label, lj.parent_key)               AS title,
          NULL::text                                       AS description,
          NULL::text                                       AS category,
          lj.resolved_agent_key                            AS agent_id,
          NULL::uuid                                       AS task_id,
          NULL::text                                       AS task_title,
          u.name                                           AS agent_name,
          lj.parent_key                                    AS job_id,
          COALESCE(lj.label, lj.parent_key)               AS job_name,
          lj.model,
          lj.tokens_input,
          lj.tokens_output,
          lj.cost_usd
        FROM latest_per_job lj
        LEFT JOIN users u ON u.agent_id = lj.resolved_agent_key
        WHERE 1=1
      `;
      const cronParams = [];
      let cp = 1;

      if (agent_id) {
        // filter inside the CTE result — resolved_agent_key is exposed as agent_id alias
        cronQuery += ` AND lj.resolved_agent_key = $${cp++}`;
        cronParams.push(agent_id);
      }
      if (start_date) {
        cronQuery += ` AND lj.last_updated_at >= $${cp++}`;
        cronParams.push(start_date);
      }
      if (end_date) {
        cronQuery += ` AND lj.last_updated_at <= $${cp++}`;
        cronParams.push(end_date);
      }

      cronQuery += ` ORDER BY lj.last_updated_at DESC`;

      try {
        const cronResult = await pool.query(cronQuery, cronParams);
        cronRows = cronResult.rows;
      } catch (_cronErr) {
        // session_usage table may not exist in all environments — degrade gracefully
        cronRows = [];
      }
    }

    // Merge, sort by timestamp DESC, paginate
    const merged = [...activityRows, ...cronRows].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );

    const total = merged.length;
    const page = merged.slice(offsetNum, offsetNum + limitNum);

    res.json({
      data: page,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/activity - List all activity logs with optional filtering
router.get('/', async (req, res, next) => {
  try {
    const { category, agent_id, task_id, limit = 100, offset = 0, start_date, end_date } = req.query;
    
    const limitNum = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetNum = Math.max(0, parseInt(offset) || 0);
    
    if (task_id) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(task_id)) {
        return res.status(400).json({ error: { message: 'Invalid UUID format for task_id', status: 400 } });
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
        total: result.rowCount
      }
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
      [id]
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
    const { title, description, category, agent_id, task_id, timestamp } = req.body;
    
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Title is required', status: 400 } });
    }
    
    if (!description || description.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Description is required', status: 400 } });
    }
    
    if (title.length > 500) {
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }
    
    const result = await pool.query(`
      INSERT INTO activity_logs (title, description, category, agent_id, task_id, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [title, description, category, agent_id || null, task_id || null, timestamp || new Date()]);
    
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
      return res.status(400).json({ error: { message: 'Description cannot be empty', status: 400 } });
    }
    
    if (title && title.length > 500) {
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }
    
    const updates = [];
    const params = [];
    let paramCount = 1;
    
    if (title !== undefined) { updates.push(`title = $${paramCount}`); params.push(title); paramCount++; }
    if (description !== undefined) { updates.push(`description = $${paramCount}`); params.push(description); paramCount++; }
    if (category !== undefined) { updates.push(`category = $${paramCount}`); params.push(category); paramCount++; }
    if (agent_id !== undefined) { updates.push(`agent_id = $${paramCount}`); params.push(agent_id); paramCount++; }
    if (task_id !== undefined) { updates.push(`task_id = $${paramCount}`); params.push(task_id); paramCount++; }
    if (timestamp !== undefined) { updates.push(`timestamp = $${paramCount}`); params.push(timestamp); paramCount++; }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
    }
    
    params.push(id);
    
    const result = await pool.query(`
      UPDATE activity_logs
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `, params);
    
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

module.exports = router;
