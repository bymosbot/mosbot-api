const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
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

// Helper to validate email format
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// GET /api/v1/users - List all users
router.get('/', async (req, res, next) => {
  try {
    const { limit = 100, offset = 0, search } = req.query;
    
    let query = 'SELECT id, name, email, avatar_url, created_at, updated_at FROM users';
    const params = [];
    let paramCount = 1;
    
    if (search) {
      query += ` WHERE name ILIKE $${paramCount} OR email ILIKE $${paramCount}`;
      params.push(`%${search}%`);
      paramCount++;
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
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

// GET /api/v1/users/:id - Get a single user by ID
router.get('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT id, name, email, avatar_url, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/users - Create a new user
router.post('/', async (req, res, next) => {
  try {
    const { name, email, password, avatar_url } = req.body;
    
    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Name is required', status: 400 } });
    }
    
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: { message: 'Valid email is required', status: 400 } });
    }
    
    if (!password || password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters', status: 400 } });
    }
    
    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: { message: 'Email already exists', status: 409 } });
    }
    
    // Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);
    
    const result = await pool.query(`
      INSERT INTO users (name, email, password_hash, avatar_url)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, email, avatar_url, created_at, updated_at
    `, [name, email, password_hash, avatar_url]);
    
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/users/:id - Update a user
router.put('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, password, avatar_url } = req.body;
    
    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }
    
    // Validation
    if (name !== undefined && name.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Name cannot be empty', status: 400 } });
    }
    
    if (email !== undefined && !isValidEmail(email)) {
      return res.status(400).json({ error: { message: 'Invalid email format', status: 400 } });
    }
    
    // Check email uniqueness if changing email
    if (email !== undefined) {
      const duplicate = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, id]);
      if (duplicate.rows.length > 0) {
        return res.status(409).json({ error: { message: 'Email already exists', status: 409 } });
      }
    }
    
    if (password !== undefined && password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters', status: 400 } });
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
    
    if (avatar_url !== undefined) {
      updates.push(`avatar_url = $${paramCount}`);
      params.push(avatar_url);
      paramCount++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update', status: 400 } });
    }
    
    params.push(id);
    
    const result = await pool.query(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, name, email, avatar_url, created_at, updated_at
    `, params);
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/users/:id - Partial update a user
router.patch('/:id', validateUUID('id'), async (req, res, next) => {
  // Reuse PUT logic for PATCH
  req.method = 'PUT';
  return router.handle(req, res, next);
});

// DELETE /api/v1/users/:id - Delete a user
router.delete('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }
    
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
