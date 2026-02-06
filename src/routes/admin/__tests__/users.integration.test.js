/**
 * Integration tests for owner protection scenarios
 * 
 * These tests verify that owner protection mechanisms work correctly:
 * - Admin cannot edit/delete owner
 * - Owner cannot change own role
 * - Owner cannot deactivate self
 * - Attempting to create second owner fails (partial unique index)
 * 
 * Note: These tests require a test database to be configured.
 * Set TEST_DB_* environment variables or use a test database.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('../../../db/pool');
const runMigrations = require('../../../db/runMigrations');
const usersRouter = require('../users');
const authRouter = require('../../auth');

// Helper to create a test user
async function createTestUser(name, email, password, role = 'user') {
  const password_hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, name, email, role, active`,
    [name, email, password_hash, role]
  );
  return result.rows[0];
}

// Helper to get JWT token for a user
function getToken(userId, role) {
  const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
  return jwt.sign(
    { id: userId, role, email: 'test@example.com' },
    jwtSecret,
    { expiresIn: '1h' }
  );
}

// Helper to clean up test users
async function cleanupTestUsers() {
  await pool.query("DELETE FROM users WHERE email LIKE 'test-%@example.com'");
}

describe('Owner Protection Integration Tests', () => {
  let app;
  let ownerUser;
  let adminUser;
  let regularUser;
  let ownerToken;
  let adminToken;
  let _userToken;

  beforeAll(async () => {
    // Run migrations to ensure schema exists
    try {
      await runMigrations({ endPool: false });
    } catch (error) {
      // If migrations fail, log and continue (might be connection issue)
      console.error('Migration setup failed:', error.message);
      // Don't throw - let the test fail with a clearer error
    }

    // Set up Express app
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRouter);
    app.use('/api/v1/admin/users', usersRouter);

    // Create test users
    ownerUser = await createTestUser('Owner User', 'test-owner@example.com', 'password123', 'owner');
    adminUser = await createTestUser('Admin User', 'test-admin@example.com', 'password123', 'admin');
    regularUser = await createTestUser('Regular User', 'test-user@example.com', 'password123', 'user');

    // Get tokens
    ownerToken = getToken(ownerUser.id, 'owner');
    adminToken = getToken(adminUser.id, 'admin');
    _userToken = getToken(regularUser.id, 'user');
  });

  afterAll(async () => {
    await cleanupTestUsers();
    await pool.end();
  });

  describe('Admin cannot edit owner', () => {
    test('should return 403 when admin tries to update owner name', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Updated Owner Name' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admins cannot edit the owner account');
    });

    test('should return 403 when admin tries to update owner email', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'newowner@example.com' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admins cannot edit the owner account');
    });
  });

  describe('Owner self-protection: cannot change own role', () => {
    test('should return 400 when owner tries to change own role to admin', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Owner cannot change their own role');
    });

    test('should return 400 when owner tries to change own role to user', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'user' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Owner cannot change their own role');
    });
  });

  describe('Owner self-protection: cannot deactivate self', () => {
    test('should return 400 when owner tries to deactivate own account', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ active: false });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Owner cannot deactivate their own account');
    });
  });

  describe('Owner cannot be deleted', () => {
    test('should return 403 when admin tries to delete owner', async () => {
      const response = await request(app)
        .delete(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admins cannot delete the owner account');
    });

    test('should return 403 when owner tries to delete owner account', async () => {
      const response = await request(app)
        .delete(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Owner account cannot be deleted');
    });
  });

  describe('Single owner constraint', () => {
    test('should prevent creating a second owner via database constraint', async () => {
      // This test verifies the partial unique index works
      // Attempt to create a second owner directly in the database
      const password_hash = await bcrypt.hash('password123', 10);
      
      await expect(
        pool.query(
          `INSERT INTO users (name, email, password_hash, role, active)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id`,
          ['Second Owner', 'test-owner2@example.com', password_hash, 'owner']
        )
      ).rejects.toThrow(); // Should fail due to partial unique index
    });
  });

  describe('Owner can edit other users', () => {
    test('should allow owner to update admin user', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${adminUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Updated Admin Name' });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Updated Admin Name');
    });

    test('should allow owner to update regular user', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${regularUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Updated User Name' });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Updated User Name');
    });
  });

  describe('Owner can update own profile (except role)', () => {
    test('should allow owner to update own name', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Updated Owner Name' });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Updated Owner Name');
      expect(response.body.data.role).toBe('owner'); // Role should remain owner
    });

    test('should allow owner to update own email', async () => {
      const newEmail = 'test-owner-new@example.com';
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: newEmail });

      expect(response.status).toBe(200);
      expect(response.body.data.email).toBe(newEmail);
      expect(response.body.data.role).toBe('owner'); // Role should remain owner
    });

    test('should allow owner to update own password', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ password: 'newpassword123' });

      expect(response.status).toBe(200);
      expect(response.body.data.role).toBe('owner'); // Role should remain owner
    });

    test('should allow owner to update own profile with role=owner (no change)', async () => {
      const response = await request(app)
        .put(`/api/v1/admin/users/${ownerUser.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ 
          name: 'Owner Profile Update',
          role: 'owner' // Explicitly sending owner role (should be allowed)
        });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Owner Profile Update');
      expect(response.body.data.role).toBe('owner');
    });
  });

  describe('User list viewing permissions', () => {
    test('should allow regular user to view user list', async () => {
      const userToken = getToken(regularUser.id, 'user');
      
      const response = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('should allow regular user to view specific user by ID', async () => {
      const userToken = getToken(regularUser.id, 'user');
      
      const response = await request(app)
        .get(`/api/v1/admin/users/${adminUser.id}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.id).toBe(adminUser.id);
      expect(response.body.data.email).toBe(adminUser.email);
    });

    test('should deny regular user from creating users', async () => {
      const userToken = getToken(regularUser.id, 'user');
      
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
      const userToken = getToken(regularUser.id, 'user');
      
      const response = await request(app)
        .put(`/api/v1/admin/users/${regularUser.id}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
    });

    test('should deny regular user from deleting users', async () => {
      const userToken = getToken(regularUser.id, 'user');
      
      // Create a test user to try to delete
      const testUser = await createTestUser('Delete Test', 'test-delete@example.com', 'password123', 'user');
      
      const response = await request(app)
        .delete(`/api/v1/admin/users/${testUser.id}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Admin access required');
      
      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [testUser.id]);
    });

    test('should deny unauthenticated access to user list', async () => {
      const response = await request(app)
        .get('/api/v1/admin/users');

      expect(response.status).toBe(401);
    });
  });
});
