const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

// Middleware to validate UUID
const validateUUID = (paramName) => (req, res, next) => {
  const id = req.params[paramName];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: { message: 'Invalid UUID format', status: 400 } });
  }
  next();
};

// GET /api/v1/tasks - List all tasks with optional filtering
router.get('/', async (req, res, next) => {
  try {
    const { status, assignee_id, reporter_id, priority, limit = 100, offset = 0 } = req.query;
    
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
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
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

// GET /api/v1/tasks/:id - Get a single task by ID
router.get('/:id', validateUUID('id'), async (req, res, next) => {
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
router.post('/', async (req, res, next) => {
  try {
    const {
      title,
      summary,
      status = 'TO DO',
      priority,
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
    
    const validStatuses = ['TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: { message: 'Invalid status', status: 400 } });
    }
    
    const validPriorities = ['High', 'Medium', 'Low'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({ error: { message: 'Invalid priority', status: 400 } });
    }
    
    const result = await pool.query(`
      INSERT INTO tasks (title, summary, status, priority, reporter_id, assignee_id, due_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [title, summary, status, priority, reporter_id, assignee_id, due_date]);
    
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/tasks/:id - Update a task
router.put('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      title,
      summary,
      status,
      priority,
      reporter_id,
      assignee_id,
      due_date
    } = req.body;
    
    // Check if task exists
    const existing = await pool.query('SELECT id FROM tasks WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    // Validation
    if (title !== undefined && title.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Title cannot be empty', status: 400 } });
    }
    
    if (title && title.length > 500) {
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
    }
    
    const validStatuses = ['TO DO', 'IN PROGRESS', 'DONE', 'ARCHIVE'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: { message: 'Invalid status', status: 400 } });
    }
    
    const validPriorities = ['High', 'Medium', 'Low'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({ error: { message: 'Invalid priority', status: 400 } });
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
    
    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
    }
    
    params.push(id);
    
    const result = await pool.query(`
      UPDATE tasks
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `, params);
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/tasks/:id - Partial update a task
router.patch('/:id', validateUUID('id'), async (req, res, next) => {
  // Reuse PUT logic for PATCH
  req.method = 'PUT';
  return router.handle(req, res, next);
});

// DELETE /api/v1/tasks/:id - Delete a task
router.delete('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Task not found', status: 404 } });
    }
    
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
