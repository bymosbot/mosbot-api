/**
 * Unit tests for users routes
 */

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');

jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn(),
}));

const pool = require('../../db/pool');
const usersRouter = require('../users');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/users', usersRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: { message: err.message, status: err.status || 500 },
    });
  });
  return app;
}

describe('Users Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
  });

  describe('GET /api/v1/users', () => {
    it('should return paginated users', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: 'user-1', name: 'User 1', email: 'user1@example.com' },
          { id: 'user-2', name: 'User 2', email: 'user2@example.com' },
        ],
        rowCount: 2,
      });

      const response = await request(app).get('/api/v1/users?limit=10&offset=0');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.pagination).toEqual({ limit: 10, offset: 0, total: 2 });
    });

    it('should filter by active_only=true', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'user-1', name: 'User 1', active: true }],
        rowCount: 1,
      });

      const response = await request(app).get('/api/v1/users?active_only=true');

      expect(response.status).toBe(200);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('active = true'),
        expect.any(Array),
      );
    });

    it('should search by name or email', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'user-1', name: 'John Doe', email: 'john@example.com' }],
        rowCount: 1,
      });

      const response = await request(app).get('/api/v1/users?search=john');

      expect(response.status).toBe(200);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.arrayContaining(['%john%']),
      );
    });

    it('should combine filters', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'user-1', name: 'John', active: true }],
        rowCount: 1,
      });

      const response = await request(app).get('/api/v1/users?active_only=true&search=john');

      expect(response.status).toBe(200);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('active = true'),
        expect.any(Array),
      );
    });

    it('should enforce max limit of 1000', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      await request(app).get('/api/v1/users?limit=2000');

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([1000]));
    });

    it('should enforce min limit of 1', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      await request(app).get('/api/v1/users?limit=0');

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([1]));
    });
  });

  describe('GET /api/v1/users/:id', () => {
    it('should return user by ID', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'user-1', name: 'User 1', email: 'user1@example.com' }],
      });

      const response = await request(app).get('/api/v1/users/550e8400-e29b-41d4-a716-446655440000');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('id', 'user-1');
    });

    it('should return 404 when user not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app).get('/api/v1/users/550e8400-e29b-41d4-a716-446655440000');

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('User not found');
    });

    it('should reject invalid UUID', async () => {
      const response = await request(app).get('/api/v1/users/invalid-uuid');

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid UUID format');
    });
  });

  describe('POST /api/v1/users', () => {
    it('should create a new user', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // email check
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'user-1',
              name: 'New User',
              email: 'new@example.com',
              avatar_url: null,
              active: true,
              created_at: '2025-01-01T00:00:00Z',
              updated_at: '2025-01-01T00:00:00Z',
            },
          ],
        });
      bcrypt.hash.mockResolvedValueOnce('hashed-password');

      const response = await request(app).post('/api/v1/users').send({
        name: 'New User',
        email: 'new@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toHaveProperty('name', 'New User');
      expect(bcrypt.hash).toHaveBeenCalledWith('password123', 10);
    });

    it('should reject when name is missing', async () => {
      const response = await request(app).post('/api/v1/users').send({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Name is required');
    });

    it('should reject when name is empty', async () => {
      const response = await request(app).post('/api/v1/users').send({
        name: '   ',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Name is required');
    });

    it('should reject invalid email', async () => {
      const response = await request(app).post('/api/v1/users').send({
        name: 'Test User',
        email: 'invalid-email',
        password: 'password123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Valid email is required');
    });

    it('should reject when email is missing', async () => {
      const response = await request(app).post('/api/v1/users').send({
        name: 'Test User',
        password: 'password123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Valid email is required');
    });

    it('should reject password shorter than 8 characters', async () => {
      const response = await request(app).post('/api/v1/users').send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'short',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Password must be at least 8 characters');
    });

    it('should reject when password is missing', async () => {
      const response = await request(app).post('/api/v1/users').send({
        name: 'Test User',
        email: 'test@example.com',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Password must be at least 8 characters');
    });

    it('should reject duplicate email', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'existing-user' }],
      });

      const response = await request(app).post('/api/v1/users').send({
        name: 'Test User',
        email: 'existing@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toBe('Email already exists');
    });

    it('should accept optional avatar_url', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            name: 'New User',
            email: 'new@example.com',
            avatar_url: 'https://example.com/avatar.jpg',
            active: true,
          },
        ],
      });
      bcrypt.hash.mockResolvedValueOnce('hashed-password');

      const response = await request(app).post('/api/v1/users').send({
        name: 'New User',
        email: 'new@example.com',
        password: 'password123',
        avatar_url: 'https://example.com/avatar.jpg',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.avatar_url).toBe('https://example.com/avatar.jpg');
    });
  });

  describe('PUT /api/v1/users/:id', () => {
    it('should update user', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] }) // existing check
        .mockResolvedValueOnce({ rows: [] }) // email uniqueness check
        .mockResolvedValueOnce({
          rows: [{ id: 'user-1', name: 'Updated Name', email: 'updated@example.com' }],
        });
      bcrypt.hash.mockResolvedValueOnce('hashed-password');

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'Updated Name',
          email: 'updated@example.com',
        });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Updated Name');
    });

    it('should return 404 when user not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('User not found');
    });

    it('should reject invalid UUID', async () => {
      const response = await request(app).put('/api/v1/users/invalid-uuid').send({ name: 'Test' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid UUID format');
    });

    it('should prevent updating owner', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 'owner-1', role: 'owner' }] });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain('Owner account cannot be modified');
    });

    it('should reject empty name', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ name: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Name cannot be empty');
    });

    it('should reject invalid email', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ email: 'invalid-email' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid email format');
    });

    it('should reject duplicate email', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'other-user' }] });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ email: 'existing@example.com' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toBe('Email already exists');
    });

    it('should update password', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'user-1', name: 'User 1', email: 'user1@example.com' }],
        });
      bcrypt.hash.mockResolvedValueOnce('new-hashed-password');

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ password: 'newpassword123' });

      expect(response.status).toBe(200);
      expect(bcrypt.hash).toHaveBeenCalledWith('newpassword123', 10);
    });

    it('should reject password shorter than 8 characters', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ password: 'short' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Password must be at least 8 characters');
    });

    it('should update avatar_url', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'user-1', avatar_url: 'https://example.com/new-avatar.jpg' }],
        });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ avatar_url: 'https://example.com/new-avatar.jpg' });

      expect(response.status).toBe(200);
      expect(response.body.data.avatar_url).toBe('https://example.com/new-avatar.jpg');
    });

    it('should reject when no fields to update', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] });

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('No fields to update');
    });
  });

  describe('PATCH /api/v1/users/:id', () => {
    it('should use PUT handler', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'user-1', name: 'Patched Name' }],
        });

      const response = await request(app)
        .patch('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ name: 'Patched Name' });

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Patched Name');
    });
  });

  describe('DELETE /api/v1/users/:id', () => {
    it('should delete user', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ role: 'user' }] }) // role check
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }); // delete

      const response = await request(app).delete(
        '/api/v1/users/550e8400-e29b-41d4-a716-446655440000',
      );

      expect(response.status).toBe(204);
    });

    it('should return 404 when user not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app).delete(
        '/api/v1/users/550e8400-e29b-41d4-a716-446655440000',
      );

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('User not found');
    });

    it('should reject invalid UUID', async () => {
      const response = await request(app).delete('/api/v1/users/invalid-uuid');

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Invalid UUID format');
    });

    it('should prevent deleting owner', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

      const response = await request(app).delete(
        '/api/v1/users/550e8400-e29b-41d4-a716-446655440000',
      );

      expect(response.status).toBe(403);
      expect(response.body.error.message).toContain('Owner account cannot be deleted');
    });

    it('should handle delete when user already deleted', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ role: 'user' }] })
        .mockResolvedValueOnce({ rows: [] }); // delete returns no rows

      const response = await request(app).delete(
        '/api/v1/users/550e8400-e29b-41d4-a716-446655440000',
      );

      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('User not found');
    });
  });

  describe('Error handling', () => {
    it('should handle database error on GET /users', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await request(app).get('/api/v1/users');

      expect(response.status).toBe(500);
    });

    it('should handle database error on GET /users/:id', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await request(app).get('/api/v1/users/550e8400-e29b-41d4-a716-446655440000');

      expect(response.status).toBe(500);
    });

    it('should handle database error on POST /users', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await request(app).post('/api/v1/users').send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(500);
    });

    it('should handle database error on PUT /users/:id', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', role: 'user' }] })
        .mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await request(app)
        .put('/api/v1/users/550e8400-e29b-41d4-a716-446655440000')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(500);
    });

    it('should handle database error on DELETE /users/:id', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await request(app).delete(
        '/api/v1/users/550e8400-e29b-41d4-a716-446655440000',
      );

      expect(response.status).toBe(500);
    });
  });
});
