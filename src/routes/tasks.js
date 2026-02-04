const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');

// Middleware to validate UUID
const validateUUID = (paramName) => (req, res, next) => {
  const id = req.params[paramName];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: { message: 'Invalid UUID format', status: 400 } });
  }
  next();
};

// Optional auth middleware - sets req.user if valid token present, but doesn't reject
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    
    try {
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;
    } catch (err) {
      // Invalid token - continue without setting req.user
    }
  }
  
  next();
};

// Helper to log task events
async function logTaskEvent(client, taskId, eventType, source, actorId, oldValues, newValues, meta = null) {
  await client.query(`
    INSERT INTO task_logs (task_id, event_type, source, actor_id, old_values, new_values, meta)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    taskId,
    eventType,
    source,
    actorId || null,
    oldValues ? JSON.stringify(oldValues) : null,
    newValues ? JSON.stringify(newValues) : null,
    meta ? JSON.stringify(meta) : null
  ]);
}

// Helper to compute diff between old and new task objects
function computeTaskDiff(oldTask, newTask) {
  const oldValues = {};
  const newValues = {};
  const fieldsToCompare = ['title', 'summary', 'status', 'priority', 'type', 'reporter_id', 'assignee_id', 'due_date', 'done_at', 'archived_at'];
  
  for (const field of fieldsToCompare) {
    const oldVal = oldTask[field];
    const newVal = newTask[field];
    
    // Compare values (handle null/undefined)
    if (oldVal !== newVal) {
      oldValues[field] = oldVal;
      newValues[field] = newVal;
    }
  }
  
  return { oldValues, newValues };
}

// GET /api/v1/tasks - List all tasks with optional filtering
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { status, assignee_id, reporter_id, priority, include_archived, limit = 100, offset = 0 } = req.query;
    
    // Validate pagination parameters
    const limitNum = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetNum = Math.max(0, parseInt(offset) || 0);
    
    let query = `
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (status) {
      query += ` AND t.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    } else if (include_archived !== 'true') {
      // Exclude archived tasks by default unless explicitly requested
      query += ` AND t.status != 'ARCHIVE'`;
    }
    
    if (assignee_id) {
      query += ` AND t.assignee_id = $${paramCount}`;
      params.push(assignee_id);
      paramCount++;
    }
    
    if (reporter_id) {
      query += ` AND t.reporter_id = $${paramCount}`;
      params.push(reporter_id);
      paramCount++;
    }
    
    if (priority) {
      query += ` AND t.priority = $${paramCount}`;
      params.push(priority);
      paramCount++;
    }
    
    query += ` ORDER BY t.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
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

// GET /api/v1/tasks/:id - Get a single task by ID
router.get('/:id', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_reporter.avatar_url as reporter_avatar,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email,
        u_assignee.avatar_url as assignee_avatar
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      WHERE t.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/tasks - Create a new task
router.post('/', optionalAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      title,
      summary,
      status = 'PLANNING',
      priority,
      type = 'task',
      reporter_id,
      assignee_id,
      due_date
    } = req.body;
    
    // Validation
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Title is required', status: 400 } });
    }
    
    if (title.length > 500) {
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }
    
    const validStatuses = ['PLANNING', 'TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: { message: 'Invalid status', status: 400 } });
    }
    
    const validPriorities = ['High', 'Medium', 'Low'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({ error: { message: 'Invalid priority', status: 400 } });
    }
    
    const validTypes = ['task', 'bug', 'feature', 'improvement', 'research'];
    if (type && !validTypes.includes(type)) {
      return res.status(400).json({ error: { message: 'Invalid type', status: 400 } });
    }
    
    // Auto-set reporter_id to authenticated user if not provided
    const finalReporterId = reporter_id || req.user?.id || null;
    
    await client.query('BEGIN');
    
    const result = await client.query(`
      INSERT INTO tasks (title, summary, status, priority, type, reporter_id, assignee_id, due_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [title, summary, status, priority, type, finalReporterId, assignee_id, due_date]);
    
    const newTask = result.rows[0];
    
    // Log the creation event
    const newValues = {
      title: newTask.title,
      summary: newTask.summary,
      status: newTask.status,
      type: newTask.type,
      priority: newTask.priority,
      reporter_id: newTask.reporter_id,
      assignee_id: newTask.assignee_id,
      due_date: newTask.due_date
    };
    
    await logTaskEvent(
      client,
      newTask.id,
      'CREATED',
      'api',
      req.user?.id,
      null,
      newValues
    );
    
    await client.query('COMMIT');
    
    // Fetch the complete task with reporter and assignee names
    const completeTask = await client.query(`
      SELECT 
        t.*,
        u_reporter.name as reporter_name,
        u_reporter.email as reporter_email,
        u_assignee.name as assignee_name,
        u_assignee.email as assignee_email
      FROM tasks t
      LEFT JOIN users u_reporter ON t.reporter_id = u_reporter.id
      LEFT JOIN users u_assignee ON t.assignee_id = u_assignee.id
      WHERE t.id = $1
    `, [newTask.id]);
    
    res.status(201).json({ data: completeTask.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// PUT /api/v1/tasks/:id - Update a task
router.put('/:id', optionalAuth, validateUUID('id'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      title,
      summary,
      status,
      priority,
      type,
      reporter_id,
      assignee_id,
      due_date
    } = req.body;
    
    await client.query('BEGIN');
    
    // Fetch full existing task for diff computation
    const existing = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    const oldTask = existing.rows[0];
    const currentStatus = oldTask.status;
    
    // Validation
    if (title !== undefined && title.trim().length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Title cannot be empty', status: 400 } });
    }
    
    if (title && title.length > 500) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }
    
    const validStatuses = ['PLANNING', 'TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE'];
    if (status && !validStatuses.includes(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Invalid status', status: 400 } });
    }
    
    const validPriorities = ['High', 'Medium', 'Low'];
    if (priority && !validPriorities.includes(priority)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Invalid priority', status: 400 } });
    }
    
    const validTypes = ['task', 'bug', 'feature', 'improvement', 'research'];
    if (type && !validTypes.includes(type)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Invalid type', status: 400 } });
    }
    
    // Build dynamic update query
    const updates = [];
    const params = [];
    let paramCount = 1;
    
    if (title !== undefined) {
      updates.push(`title = $${paramCount}`);
      params.push(title);
      paramCount++;
    }
    
    if (summary !== undefined) {
      updates.push(`summary = $${paramCount}`);
      params.push(summary);
      paramCount++;
    }
    
    if (status !== undefined) {
      updates.push(`status = $${paramCount}`);
      params.push(status);
      paramCount++;
    }
    
    if (priority !== undefined) {
      updates.push(`priority = $${paramCount}`);
      params.push(priority);
      paramCount++;
    }
    
    if (type !== undefined) {
      updates.push(`type = $${paramCount}`);
      params.push(type);
      paramCount++;
    }
    
    if (reporter_id !== undefined) {
      updates.push(`reporter_id = $${paramCount}`);
      params.push(reporter_id);
      paramCount++;
    }
    
    if (assignee_id !== undefined) {
      updates.push(`assignee_id = $${paramCount}`);
      params.push(assignee_id);
      paramCount++;
    }
    
    if (due_date !== undefined) {
      updates.push(`due_date = $${paramCount}`);
      params.push(due_date);
      paramCount++;
    }
    
    // Handle status transitions for done_at and archived_at
    if (status !== undefined && status !== currentStatus) {
      // Transition to DONE: set done_at
      if (status === 'DONE') {
        updates.push(`done_at = NOW()`);
      }
      // Transition away from DONE: clear done_at (but preserve it when archiving)
      if (currentStatus === 'DONE' && status !== 'DONE' && status !== 'ARCHIVE') {
        updates.push(`done_at = NULL`);
      }
      // Transition to ARCHIVE: set archived_at
      if (status === 'ARCHIVE') {
        updates.push(`archived_at = NOW()`);
      }
      // Transition away from ARCHIVE: clear archived_at
      if (currentStatus === 'ARCHIVE' && status !== 'ARCHIVE') {
        updates.push(`archived_at = NULL`);
      }
    }
    
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
    }
    
    params.push(id);
    
    const result = await client.query(`
      UPDATE tasks
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `, params);
    
    const updatedTask = result.rows[0];
    
    // Compute diff and log the change
    const { oldValues, newValues } = computeTaskDiff(oldTask, updatedTask);
    
    // Determine event type
    let eventType = 'UPDATED';
    if (oldValues.status && oldValues.status !== newValues.status) {
      if (newValues.status === 'ARCHIVE' && currentStatus !== 'ARCHIVE') {
        eventType = 'ARCHIVED_MANUAL';
      } else if (oldValues.status === 'ARCHIVE' && newValues.status !== 'ARCHIVE') {
        eventType = 'RESTORED';
      } else {
        eventType = 'STATUS_CHANGED';
      }
    }
    
    await logTaskEvent(
      client,
      id,
      eventType,
      'api',
      req.user?.id,
      oldValues,
      newValues
    );
    
    await client.query('COMMIT');
    
    res.json({ data: updatedTask });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// PATCH /api/v1/tasks/:id - Partial update a task
router.patch('/:id', validateUUID('id'), async (req, res, next) => {
  // Reuse PUT logic for PATCH
  req.method = 'PUT';
  return router.handle(req, res, next);
});

// GET /api/v1/tasks/:id/history - Get history/audit log for a task
router.get('/:id/history', optionalAuth, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    // First check if task exists
    const taskExists = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (taskExists.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    const result = await pool.query(`
      SELECT 
        tl.*,
        u.name as actor_name,
        u.email as actor_email,
        u.avatar_url as actor_avatar
      FROM task_logs tl
      LEFT JOIN users u ON tl.actor_id = u.id
      WHERE tl.task_id = $1
      ORDER BY tl.occurred_at DESC
      LIMIT $2 OFFSET $3
    `, [id, parseInt(limit), parseInt(offset)]);
    
    res.json({
      data: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: result.rowCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/tasks/:id - Delete a task
router.delete('/:id', optionalAuth, validateUUID('id'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    
    await client.query('BEGIN');
    
    // Fetch task before deleting to log the event
    const existing = await client.query('SELECT title, status FROM tasks WHERE id = $1', [id]);
    
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    const oldTask = existing.rows[0];
    
    // Log deletion before actually deleting (since cascade will remove logs)
    await logTaskEvent(
      client,
      id,
      'DELETED',
      'api',
      req.user?.id,
      { title: oldTask.title, status: oldTask.status },
      null
    );
    
    await client.query('DELETE FROM tasks WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
