const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// POST /api/v1/auth/login - Authenticate user and return JWT token
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({ 
        error: { message: 'Email and password are required', status: 400 } 
      });
    }
    
    // Find user by email
    const result = await pool.query(
      'SELECT id, name, email, password_hash, avatar_url FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ 
        error: { message: 'Invalid credentials', status: 401 } 
      });
    }
    
    const user = result.rows[0];
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ 
        error: { message: 'Invalid credentials', status: 401 } 
      });
    }
    
    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';
    
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email,
        name: user.name
      },
      jwtSecret,
      { expiresIn: jwtExpiresIn }
    );
    
    // Return user data and token (exclude password_hash)
    res.json({
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatar_url: user.avatar_url
        },
        token,
        expires_in: jwtExpiresIn
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/register - Register a new user
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, avatar_url } = req.body;
    
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
    
    // Create user
    const result = await pool.query(`
      INSERT INTO users (name, email, password_hash, avatar_url)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, email, avatar_url, created_at
    `, [name, email, password_hash, avatar_url]);
    
    const user = result.rows[0];
    
    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';
    
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email,
        name: user.name
      },
      jwtSecret,
      { expiresIn: jwtExpiresIn }
    );
    
    res.status(201).json({
      data: {
        user,
        token,
        expires_in: jwtExpiresIn
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/verify - Verify JWT token
router.post('/verify', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: { message: 'No token provided', status: 401 } 
      });
    }
    
    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    
    try {
      const decoded = jwt.verify(token, jwtSecret);
      
      // Optionally verify user still exists in database
      const result = await pool.query(
        'SELECT id, name, email, avatar_url FROM users WHERE id = $1',
        [decoded.id]
      );
      
      if (result.rows.length === 0) {
        return res.status(401).json({ 
          error: { message: 'User not found', status: 401 } 
        });
      }
      
      res.json({
        data: {
          valid: true,
          user: result.rows[0]
        }
      });
    } catch (jwtError) {
      return res.status(401).json({ 
        error: { message: 'Invalid or expired token', status: 401 } 
      });
    }
  } catch (error) {
    next(error);
  }
});

// Middleware to protect routes (can be imported and used in other route files)
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: { message: 'No token provided', status: 401 } 
    });
  }
  
  const token = authHeader.substring(7);
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  
  jwt.verify(token, jwtSecret, (err, user) => {
    if (err) {
      return res.status(401).json({ 
        error: { message: 'Invalid or expired token', status: 401 } 
      });
    }
    
    req.user = user;
    next();
  });
};

module.exports = router;
module.exports.authenticateToken = authenticateToken;
