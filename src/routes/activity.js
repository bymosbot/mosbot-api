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

// GET /api/v1/activity - List all activity logs with optional filtering
router.get('/', async (req, res, next) => {
  try {
    const { category, limit = 100, offset = 0, start_date, end_date } = req.query;
    
    let query = 'SELECT * FROM activity_logs WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (category) {
      query += ` AND category = $${paramCount}`;
      params.push(category);
      paramCount++;
    }
    
    if (start_date) {
      query += ` AND timestamp >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }
    
    if (end_date) {
      query += ` AND timestamp <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }
    
    query += ` ORDER BY timestamp DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
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

// GET /api/v1/activity/:id - Get a single activity log by ID
router.get('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('SELECT * FROM activity_logs WHERE id = $1', [id]);
    
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
    const { title, description, category, timestamp } = req.body;
    
    // Validation
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
      INSERT INTO activity_logs (title, description, category, timestamp)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [title, description, category, timestamp || new Date()]);
    
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/activity/:id - Update an activity log
router.put('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, category, timestamp } = req.body;
    
    // Check if activity log exists
    const existing = await pool.query('SELECT id FROM activity_logs WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Activity log not found', status: 404 } });
    }
    
    // Validation
    if (title !== undefined && title.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Title cannot be empty', status: 400 } });
    }
    
    if (description !== undefined && description.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Description cannot be empty', status: 400 } });
    }
    
    if (title && title.length > 500) {
      return res.status(400).json({ error: { message: 'Title must be 500 characters or less', status: 400 } });
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
    
    if (timestamp !== undefined) {
      updates.push(`timestamp = $${paramCount}`);
      params.push(timestamp);
      paramCount++;
    }
    
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
  // Reuse PUT logic for PATCH
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
