/**
 * Unit tests for owner protection scenarios
 *
 * These tests verify that owner protection mechanisms work correctly:
 * - Admin cannot edit/delete owner
 * - Owner cannot change own role
 * - Owner cannot deactivate self
 * - Single owner constraint (via API role validation)
 *
 * Uses mocked pool.query so no live database is needed.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock the pool before requiring any modules that use it
jest.mock('../../../db/pool', () => ({
  query: jest.fn(),
  end: jest.fn()
}));

const pool = require('../../../db/pool');
const usersRouter = require('../users');

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  return jwt.sign(
    { id: userId, role, email: `test-${role}@example.com` },
    jwtSecret,
    { expiresIn: '1h' }
  );
}

// Fixed test user IDs
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';

const ownerUser = { id: OWNER_ID, name: 'Owner User', email: 'test-owner@example.com', role: 'owner', active: true };
const adminUser = { id: ADMIN_ID, name: 'Admin User', email: 'test-admin@example.com', role: 'admin', active: true };
const regularUser = { id: USER_ID, name: 'Regular User', email: 'test-user@example.com', role: 'user', active: true };

// Lookup map for authenticateToken middleware
const usersById = {
  [OWNER_ID]: ownerUser,
  [ADMIN_ID]: adminUser,
  [USER_ID]: regularUser
};

/**
 * Default pool.query mock implementation.
 * Routes queries to the correct mock response based on the SQL text.
 */
function defaultQueryMock(sql, params) {
  // authenticateToken middleware: verify user exists and is active
  if (sql.includes('SELECT id, name, email, role, active FROM users WHERE id')) {
    const userId = params && params[0];
    const user = usersById[userId];
    if (user) {
      return Promise.resolve({ rows: [user] });
    }
    return Promise.resolve({ rows: [] });
  }

  // PUT route: check target user exists and get role
  if (sql.includes('SELECT id, role FROM users WHERE id')) {
    const userId = params && params[0];
    const user = usersById[userId];
    if (user) {
      return Promise.resolve({ rows: [{ id: user.id, role: user.role }] });
    }
    return Promise.resolve({ rows: [] });
  }

  // DELETE route: check target user role
  if (sql.includes('SELECT role FROM users WHERE id')) {
    const userId = params && params[0];
    const user = usersById[userId];
    if (user) {
      return Promise.resolve({ rows: [{ role: user.role }] });
    }
    return Promise.resolve({ rows: [] });
  }

  // PUT route: check email uniqueness
  if (sql.includes('SELECT id FROM users WHERE email') && sql.includes('AND id !=')) {
    return Promise.resolve({ rows: [] }); // no conflict
  }

  // POST route: check email uniqueness
  if (sql.includes('SELECT id FROM users WHERE email')) {
    return Promise.resolve({ rows: [] }); // no conflict
  }

  // UPDATE query - return updated user
  if (sql.includes('UPDATE users')) {
    const userId = params && params[params.length - 1];
    const user = usersById[userId];
    if (user) {
      // Build an updated user from the request
      return Promise.resolve({
        rows: [{
          ...user,
          updated_at: new Date().toISOString()
        }]
      });
    }
    return Promise.resolve({ rows: [] });
  }

  // DELETE query
  if (sql.includes('DELETE FROM users WHERE id')) {
    const userId = params && params[0];
    const user = usersById[userId];
    if (user) {
      return Promise.resolve({ rows: [{ id: user.id }] });
    }
    return Promise.resolve({ rows: [] });
  }

  // INSERT query (create user)
  if (sql.includes('INSERT INTO users')) {
    return Promise.resolve({
      rows: [{
        id: '00000000-0000-0000-0000-000000000099',
        name: params[0],
        email: params[1],
        role: params[3],
        active: true,
        created_at: new Date().toISOString()
      }]
    });
  }

  // GET list: count
  if (sql.includes('SELECT COUNT(*) as total FROM users')) {
    return Promise.resolve({ rows: [{ total: '3' }] });
  }

  // GET single user by ID
  if (sql.includes('SELECT id, name, email, avatar_url, role, active') && sql.includes('WHERE id =')) {
    const userId = params && params[0];
    const user = usersById[userId];
    if (user) {
      return Promise.resolve({ rows: [user] });
    }
    return Promise.resolve({ rows: [] });
  }

  // GET list: data
  if (sql.includes('SELECT id, name, email, avatar_url, role, active')) {
    return Promise.resolve({
      rows: [ownerUser, adminUser, regularUser],
      rowCount: 3
    });
  }

  // Default
  return Promise.resolve({ rows: [], rowCount: 0 });
}

describe('Owner Protection Tests', () => {
  let app;
  let ownerToken;
  let adminToken;
  let userToken;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/admin/users', usersRouter);

    ownerToken = getToken(OWNER_ID, 'owner');
    adminToken = getToken(ADMIN_ID, 'admin');
    userToken = getToken(USER_ID, 'user');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockImplementation(defaultQueryMock);
  });

  describe('Admin cannot edit owner', () => {
    test('should return 403 when admin tries to update owner name', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Updated Owner Name' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admins cannot edit the owner account');
    });

    test('should return 403 when admin tries to update owner email', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'newowner@example.com' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admins cannot edit the owner account');
    });
  });

  describe('Owner self-protection: cannot change own role', () => {
    test('should return 400 when owner tries to change own role to admin', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Owner cannot change their own role');
    });

    test('should return 400 when owner tries to change own role to user', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'user' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Owner cannot change their own role');
    });
  });

  describe('Owner self-protection: cannot deactivate self', () => {
    test('should return 400 when owner tries to deactivate own account', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ active: false });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Owner cannot deactivate their own account');
    });
  });

  describe('Owner cannot be deleted', () => {
    test('should return 403 when admin tries to delete owner', async () => {
      const response = await request(app)
        .delete(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Owner account cannot be deleted');
    });

    test('should return 400 when owner tries to delete own account', async () => {
      const response = await request(app)
        .delete(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Owner deleting self hits the "cannot delete your own account" guard first
      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Cannot delete your own account');
    });
  });

  describe('Single owner constraint', () => {
    test('should prevent creating a second owner via role validation', async () => {
      const response = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Second Owner',
          email: 'test-owner2@example.com',
          password: 'password123',
          role: 'owner'
        });

      // The route rejects 'owner' as an invalid role for creation
      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('Invalid role');
    });
  });

  describe('Owner can edit other users', () => {
    test('should allow owner to update admin user', async () => {
      // Override the UPDATE mock to return the updated name
      pool.query.mockImplementation((sql, params) => {
        if (sql.includes('UPDATE users')) {
          return Promise.resolve({
            rows: [{
              ...adminUser,
              name: 'Updated Admin Name',
              updated_at: new Date().toISOString()
            }]
          });
        }
        return defaultQueryMock(sql, params);
      });

      const response = await request(app)
        .put(`/api/v1/admin/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Updated Admin Name' });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Updated Admin Name');
    });

    test('should allow owner to update regular user', async () => {
      pool.query.mockImplementation((sql, params) => {
        if (sql.includes('UPDATE users')) {
          return Promise.resolve({
            rows: [{
              ...regularUser,
              name: 'Updated User Name',
              updated_at: new Date().toISOString()
            }]
          });
        }
        return defaultQueryMock(sql, params);
      });

      const response = await request(app)
        .put(`/api/v1/admin/users/${USER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Updated User Name' });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Updated User Name');
    });
  });

  describe('Owner can update own profile (except role)', () => {
    test('should allow owner to update own name', async () => {
      pool.query.mockImplementation((sql, params) => {
        if (sql.includes('UPDATE users')) {
          return Promise.resolve({
            rows: [{
              ...ownerUser,
              name: 'Updated Owner Name',
              updated_at: new Date().toISOString()
            }]
          });
        }
        return defaultQueryMock(sql, params);
      });

      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Updated Owner Name' });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Updated Owner Name');
      expect(response.body.data.role).toBe('owner');
    });

    test('should allow owner to update own email', async () => {
      const newEmail = 'test-owner-new@example.com';
      pool.query.mockImplementation((sql, params) => {
        if (sql.includes('UPDATE users')) {
          return Promise.resolve({
            rows: [{
              ...ownerUser,
              email: newEmail,
              updated_at: new Date().toISOString()
            }]
          });
        }
        return defaultQueryMock(sql, params);
      });

      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: newEmail });

      expect(response.status).toBe(200);
      expect(response.body.data.email).toBe(newEmail);
      expect(response.body.data.role).toBe('owner');
    });

    test('should allow owner to update own password', async () => {
      pool.query.mockImplementation((sql, params) => {
        if (sql.includes('UPDATE users')) {
          return Promise.resolve({
            rows: [{
              ...ownerUser,
              updated_at: new Date().toISOString()
            }]
          });
        }
        return defaultQueryMock(sql, params);
      });

      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ password: 'newpassword123' });

      expect(response.status).toBe(200);
      expect(response.body.data.role).toBe('owner');
    });

    test('should allow owner to update own profile with role=owner (no change)', async () => {
      pool.query.mockImplementation((sql, params) => {
        if (sql.includes('UPDATE users')) {
          return Promise.resolve({
            rows: [{
              ...ownerUser,
              name: 'Owner Profile Update',
              updated_at: new Date().toISOString()
            }]
          });
        }
        return defaultQueryMock(sql, params);
      });

      const response = await request(app)
        .put(`/api/v1/admin/users/${OWNER_ID}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Owner Profile Update',
          role: 'owner'
        });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Owner Profile Update');
      expect(response.body.data.role).toBe('owner');
    });
  });

  describe('User list viewing permissions', () => {
    test('should allow regular user to view user list', async () => {
      const response = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('should allow regular user to view specific user by ID', async () => {
      const response = await request(app)
        .get(`/api/v1/admin/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.id).toBe(ADMIN_ID);
    });

    test('should deny regular user from creating users', async () => {
      const response = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'New User',
          email: 'newuser@example.com',
          password: 'password123',
          role: 'user'
        });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
    });

    test('should deny regular user from updating users', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${USER_ID}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
    });

    test('should deny regular user from deleting users', async () => {
      const response = await request(app)
        .delete(`/api/v1/admin/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
    });

    test('should deny unauthenticated access to user list', async () => {
      const response = await request(app)
        .get('/api/v1/admin/users');

      expect(response.status).toBe(401);
    });
  });
});
