const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const bcrypt = require('bcrypt');
const { authenticateToken, requireAdmin } = require('../auth');
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
    const { limit = 100, offset = 0 } = req.query;
    
    // Validate pagination parameters
    const limitNum = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetNum = Math.max(0, parseInt(offset) || 0);
    
    // Get total count and paginated results in parallel
    const [countResult, dataResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM users'),
      pool.query(`
        SELECT id, name, email, avatar_url, role, active, created_at, updated_at
        FROM users
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [limitNum, offsetNum])
    ]);
    
    const total = parseInt(countResult.rows[0].total, 10);
    
    res.json({
      data: dataResult.rows,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: total
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/admin/users/:id - Get a single user by ID (all authenticated users can view)
router.get('/:id', validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT id, name, email, avatar_url, role, active, created_at, updated_at FROM users WHERE id = $1',
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

// POST /api/v1/admin/users - Create a new user (admin/owner only)
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, role = 'user', avatar_url } = req.body;
    
    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ 
        error: { message: 'Name is required', status: 400 } 
      });
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({ 
        error: { message: 'Valid email is required', status: 400 } 
      });
    }
    
    if (!password || password.length < 8) {
      return res.status(400).json({ 
        error: { message: 'Password must be at least 8 characters', status: 400 } 
      });
    }
    
    // Only agent, admin and user roles can be assigned via admin endpoints (not owner)
    const validRoles = ['agent', 'admin', 'user'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ 
        error: { message: 'Invalid role. Only agent, admin and user roles can be assigned.', status: 400 } 
      });
    }
    
    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        error: { message: 'Email already exists', status: 409 } 
      });
    }
    
    // Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);
    
    // Create user (default active = true)
    const result = await pool.query(`
      INSERT INTO users (name, email, password_hash, role, avatar_url, active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id, name, email, avatar_url, role, active, created_at
    `, [name, email, password_hash, role, avatar_url]);
    
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/admin/users/:id - Update a user (admin/owner only)
router.put('/:id', requireAdmin, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, avatar_url, active } = req.body;
    
    // Check if user exists and get their role
    const existing = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }
    
    const targetUser = existing.rows[0];
    
    // Admin/Agent cannot edit owner
    if ((req.user.role === 'admin' || req.user.role === 'agent') && targetUser.role === 'owner') {
      logger.warn('Owner protection violation: Admin/Agent attempted to edit owner account', {
        action: 'update_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        target_role: targetUser.role,
        violation_type: 'admin_edit_owner'
      });
      return res.status(403).json({ 
        error: { message: 'Admins cannot edit the owner account', status: 403 } 
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
        violation_type: 'owner_change_own_role'
      });
      return res.status(400).json({ 
        error: { message: 'Owner cannot change their own role', status: 400 } 
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
        violation_type: 'owner_deactivate_self'
      });
      return res.status(400).json({ 
        error: { message: 'Owner cannot deactivate their own account', status: 400 } 
      });
    }
    
    // Validation
    if (name !== undefined && name.trim().length === 0) {
      return res.status(400).json({ 
        error: { message: 'Name cannot be empty', status: 400 } 
      });
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email !== undefined && !emailRegex.test(email)) {
      return res.status(400).json({ 
        error: { message: 'Valid email is required', status: 400 } 
      });
    }
    
    if (password !== undefined && password.length < 8) {
      return res.status(400).json({ 
        error: { message: 'Password must be at least 8 characters', status: 400 } 
      });
    }
    
    // Only agent, admin and user roles can be assigned via admin endpoints (not owner)
    // Exception: owner can keep their own role when updating themselves
    const validRoles = ['agent', 'admin', 'user'];
    if (role !== undefined && !validRoles.includes(role)) {
      // Allow 'owner' role only if target user is already owner
      if (role !== 'owner' || targetUser.role !== 'owner') {
        return res.status(400).json({ 
          error: { message: 'Invalid role. Only agent, admin and user roles can be assigned.', status: 400 } 
        });
      }
    }
    
    // Prevent deactivating yourself
    if (active === false && id === req.user.id) {
      return res.status(400).json({ 
        error: { message: 'Cannot deactivate your own account', status: 400 } 
      });
    }
    
    // Check if email is taken by another user
    if (email) {
      const emailCheck = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, id]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ 
          error: { message: 'Email already exists', status: 409 } 
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
        error: { message: 'No fields to update', status: 400 } 
      });
    }
    
    params.push(id);
    
    const result = await pool.query(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, name, email, avatar_url, role, active, created_at, updated_at
    `, params);
    
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/admin/users/:id - Delete a user (admin/owner only)
router.delete('/:id', requireAdmin, validateUUID('id'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Prevent deleting yourself
    if (id === req.user.id) {
      return res.status(400).json({ 
        error: { message: 'Cannot delete your own account', status: 400 } 
      });
    }
    
    // Check target user's role
    const targetUser = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found', status: 404 } });
    }
    
    // Owner cannot be deleted by anyone
    if (targetUser.rows[0].role === 'owner') {
      logger.warn('Owner protection violation: Attempted to delete owner account', {
        action: 'delete_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        target_role: targetUser.rows[0].role,
        violation_type: 'delete_owner'
      });
      return res.status(403).json({ 
        error: { message: 'Owner account cannot be deleted', status: 403 } 
      });
    }
    
    // Admin/Agent cannot delete owner
    if ((req.user.role === 'admin' || req.user.role === 'agent') && targetUser.rows[0].role === 'owner') {
      logger.warn('Owner protection violation: Admin/Agent attempted to delete owner account', {
        action: 'delete_user',
        actor_id: req.user.id,
        actor_role: req.user.role,
        target_user_id: id,
        target_role: targetUser.rows[0].role,
        violation_type: 'admin_delete_owner'
      });
      return res.status(403).json({ 
        error: { message: 'Admins cannot delete the owner account', status: 403 } 
      });
    }
    
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
