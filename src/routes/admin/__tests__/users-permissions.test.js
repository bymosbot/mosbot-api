/**
 * Unit tests for user list viewing permissions
 * 
 * These tests verify that the middleware is correctly applied:
 * - GET requests (list/view) require only authentication
 * - POST/PUT/DELETE requests require agent/admin/owner role
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// Mock the pool before requiring the router
jest.mock('../../../db/pool', () => ({
  query: jest.fn()
}));

const pool = require('../../../db/pool');
const usersRouter = require('../users');

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  return jwt.sign(
    { id: userId, role, email: `${role}@example.com` },
    jwtSecret,
    { expiresIn: '1h' }
  );
}

describe('User List Permissions (Unit Tests)', () => {
  let app;

  beforeAll(() => {
    // Create Express app with routes
    app = express();
    app.use(express.json());
    app.use('/api/v1/admin/users', usersRouter);
  });

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock database responses
    pool.query.mockImplementation((query, params) => {
      // Mock user lookup for auth middleware (authenticateToken)
      // The middleware queries: SELECT id, name, email, role, active FROM users WHERE id = $1
      if (query.includes('SELECT id, name, email, role, active FROM users WHERE id')) {
        // Extract user ID from params or use default
        const userId = params && params[0] ? params[0] : 'test-id';
        // Determine role based on userId pattern
        let role = 'user';
        if (userId.includes('owner')) role = 'owner';
        else if (userId.includes('admin')) role = 'admin';
        
        return Promise.resolve({
          rows: [{ 
            id: userId, 
            name: 'Test User', 
            email: `${role}@example.com`, 
            role: role, 
            active: true 
          }]
        });
      }
      
      // Mock COUNT query for total count
      if (query.includes('SELECT COUNT(*) as total FROM users')) {
        return Promise.resolve({
          rows: [{ total: '2' }]
        });
      }
      
      // Mock user list
      if (query.includes('SELECT id, name, email, avatar_url, role, active')) {
        return Promise.resolve({
          rows: [
            { id: '1', name: 'User 1', email: 'user1@example.com', role: 'user', active: true },
            { id: '2', name: 'User 2', email: 'user2@example.com', role: 'admin', active: true }
          ],
          rowCount: 2
        });
      }
      
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  });

  describe('GET /api/v1/admin/users - List users', () => {
    it('should allow owner to list users', async () => {
      const token = getToken('owner-id', 'owner');
      
      const response = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should allow admin to list users', async () => {
      const token = getToken('admin-id', 'admin');
      
      const response = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should allow regular user to list users', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should deny unauthenticated access', async () => {
      const response = await request(app)
        .get('/api/v1/admin/users');

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('No token provided');
    });
  });

  describe('GET /api/v1/admin/users/:id - View specific user', () => {
    beforeEach(() => {
      pool.query.mockImplementation((query, params) => {
        // Mock user lookup for auth middleware (authenticateToken)
        if (query.includes('SELECT id, name, email, role, active FROM users WHERE id')) {
          const userId = params && params[0] ? params[0] : 'user-id';
          return Promise.resolve({
            rows: [{ 
              id: userId, 
              name: 'Test User', 
              email: 'test@example.com', 
              role: 'user', 
              active: true 
            }]
          });
        }
        
        // Mock specific user lookup
        if (query.includes('SELECT id, name, email, avatar_url, role, active')) {
          return Promise.resolve({
            rows: [{ 
              id: 'user-123', 
              name: 'Test User', 
              email: 'test@example.com', 
              role: 'user',
              active: true
            }]
          });
        }
        
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
    });

    it('should allow regular user to view specific user', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .get('/api/v1/admin/users/550e8400-e29b-41d4-a716-446655440000')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
    });
  });

  describe('POST /api/v1/admin/users - Create user', () => {
    it('should allow admin to create users', async () => {
      const token = getToken('admin-id', 'admin');
      
      pool.query.mockImplementation((query, params) => {
        // Mock user lookup for auth middleware (authenticateToken)
        if (query.includes('SELECT id, name, email, role, active FROM users WHERE id')) {
          const userId = params && params[0] ? params[0] : 'admin-id';
          return Promise.resolve({
            rows: [{ 
              id: userId, 
              name: 'Admin User', 
              email: 'admin@example.com', 
              role: 'admin', 
              active: true 
            }]
          });
        }
        
        // Mock email check
        if (query.includes('SELECT id FROM users WHERE email')) {
          return Promise.resolve({ rows: [] });
        }
        
        // Mock insert
        if (query.includes('INSERT INTO users')) {
          return Promise.resolve({
            rows: [{ 
              id: 'new-id', 
              name: 'New User', 
              email: 'new@example.com', 
              role: 'user' 
            }]
          });
        }
        
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
      
      const response = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'New User',
          email: 'new@example.com',
          password: 'password123',
          role: 'user'
        });

      expect(response.status).toBe(201);
    });

    it('should deny regular user from creating users', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'New User',
          email: 'new@example.com',
          password: 'password123',
          role: 'user'
        });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
    });
  });

  describe('PUT /api/v1/admin/users/:id - Update user', () => {
    it('should deny regular user from updating users', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .put('/api/v1/admin/users/550e8400-e29b-41d4-a716-446655440000')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
    });
  });

  describe('DELETE /api/v1/admin/users/:id - Delete user', () => {
    it('should deny regular user from deleting users', async () => {
      const token = getToken('user-id', 'user');
      
      const response = await request(app)
        .delete('/api/v1/admin/users/550e8400-e29b-41d4-a716-446655440000')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
    });
  });
});
