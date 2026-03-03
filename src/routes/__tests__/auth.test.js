/**
 * Unit tests for auth routes
 *
 * Tests:
 * - POST /login - authentication with email/password
 * - POST /register - user registration
 * - POST /verify - token verification
 * - GET /me - get current user from token
 */

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Mock the pool before requiring any modules that use it
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  end: jest.fn(),
}));

const pool = require('../../db/pool');
const authRouter = require('../auth');

// Helper to get JWT token for a user
function getToken(userId, role, email = 'test@example.com', name = 'Test User') {
  const jwtSecret = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production';
  return jwt.sign({ id: userId, role, email, name }, jwtSecret, {
    expiresIn: '1h',
  });
}

describe('POST /api/v1/auth/login', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 400 when email is missing', async () => {
    const response = await request(app).post('/api/v1/auth/login').send({
      password: 'password123',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Email and password are required');
  });

  it('should return 400 when password is missing', async () => {
    const response = await request(app).post('/api/v1/auth/login').send({
      email: 'test@example.com',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Email and password are required');
  });

  it('should return 401 when user does not exist', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const response = await request(app).post('/api/v1/auth/login').send({
      email: 'nonexistent@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid credentials');
  });

  it('should return 401 when password is incorrect', async () => {
    const hashedPassword = await bcrypt.hash('correctpassword', 10);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          password_hash: hashedPassword,
          avatar_url: null,
          role: 'user',
          active: true,
        },
      ],
    });

    const response = await request(app).post('/api/v1/auth/login').send({
      email: 'test@example.com',
      password: 'wrongpassword',
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid credentials');
  });

  it('should return 403 when user is inactive', async () => {
    const hashedPassword = await bcrypt.hash('password123', 10);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          password_hash: hashedPassword,
          avatar_url: null,
          role: 'user',
          active: false,
        },
      ],
    });

    const response = await request(app).post('/api/v1/auth/login').send({
      email: 'test@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe(
      'Account is deactivated. Please contact an administrator.',
    );
  });

  it('should return 200 with token when credentials are valid', async () => {
    const hashedPassword = await bcrypt.hash('password123', 10);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          password_hash: hashedPassword,
          avatar_url: null,
          role: 'user',
          active: true,
        },
      ],
    });

    const response = await request(app).post('/api/v1/auth/login').send({
      email: 'test@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeDefined();
    expect(response.body.data.user).toBeDefined();
    expect(response.body.data.user.id).toBe('user-123');
    expect(response.body.data.user.email).toBe('test@example.com');
    expect(response.body.data.user.password_hash).toBeUndefined();
    expect(response.body.data.token).toBeDefined();
    expect(response.body.data.expires_in).toBeDefined();

    // Verify token can be decoded
    const jwtSecret = process.env.JWT_SECRET || 'test-only-jwt-secret-not-for-production';
    const decoded = jwt.verify(response.body.data.token, jwtSecret);
    expect(decoded.id).toBe('user-123');
    expect(decoded.email).toBe('test@example.com');
  });
});

describe('POST /api/v1/auth/register', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 400 when name is missing', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      email: 'test@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Name is required');
  });

  it('should return 400 when name is empty', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: '   ',
      email: 'test@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Name is required');
  });

  it('should return 400 when email is invalid', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'invalid-email',
      password: 'password123',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Valid email is required');
  });

  it('should return 400 when password is too short', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'short',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Password must be at least 8 characters');
  });

  it('should return 409 when email already exists', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'existing-user' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'existing@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe('Email already exists');
  });

  it('should return 201 with token when registration is successful', async () => {
    pool.query.mockImplementation((sql, _params) => {
      // Check if email exists
      if (sql.includes('SELECT id FROM users WHERE email')) {
        return Promise.resolve({ rows: [] });
      }
      // INSERT query
      if (sql.includes('INSERT INTO users')) {
        return Promise.resolve({
          rows: [
            {
              id: 'new-user-123',
              name: 'Test User',
              email: 'newuser@example.com',
              avatar_url: null,
              role: 'user',
              active: true,
              created_at: new Date(),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'newuser@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toBeDefined();
    expect(response.body.data.user).toBeDefined();
    expect(response.body.data.user.id).toBe('new-user-123');
    expect(response.body.data.user.email).toBe('newuser@example.com');
    expect(response.body.data.token).toBeDefined();
    expect(response.body.data.expires_in).toBeDefined();

    // Verify password was hashed
    const insertCall = pool.query.mock.calls.find((call) => call[0].includes('INSERT INTO users'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1][0]).toBe('Test User');
    expect(insertCall[1][1]).toBe('newuser@example.com');
    expect(insertCall[1][2]).toMatch(/^\$2[aby]\$\d+\$/); // bcrypt hash format
    expect(insertCall[1][3]).toBeUndefined(); // avatar_url when not provided
  });

  it('should include avatar_url when provided', async () => {
    pool.query.mockImplementation((sql, _params) => {
      // Check if email exists
      if (sql.includes('SELECT id FROM users WHERE email')) {
        return Promise.resolve({ rows: [] });
      }
      // INSERT query
      if (sql.includes('INSERT INTO users')) {
        return Promise.resolve({
          rows: [
            {
              id: 'new-user-123',
              name: 'Test User',
              email: 'newuser@example.com',
              avatar_url: 'https://example.com/avatar.jpg',
              role: 'user',
              active: true,
              created_at: new Date(),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'newuser@example.com',
      password: 'password123',
      avatar_url: 'https://example.com/avatar.jpg',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.user.avatar_url).toBe('https://example.com/avatar.jpg');
  });
});

describe('POST /api/v1/auth/verify', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when no token is provided', async () => {
    const response = await request(app).post('/api/v1/auth/verify');

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('No token provided');
  });

  it('should return 401 when token format is invalid', async () => {
    const response = await request(app)
      .post('/api/v1/auth/verify')
      .set('Authorization', 'Invalid token');

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('No token provided');
  });

  it('should return 401 when token is invalid', async () => {
    const response = await request(app)
      .post('/api/v1/auth/verify')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid or expired token');
  });

  it('should return 401 when user does not exist', async () => {
    const token = getToken('nonexistent-user', 'user');
    pool.query.mockResolvedValue({ rows: [] });

    const response = await request(app)
      .post('/api/v1/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('User not found');
  });

  it('should return 403 when user is inactive', async () => {
    const token = getToken('user-123', 'user');
    pool.query.mockImplementation((sql, _params) => {
      // Both queries check user existence
      if (sql.includes('SELECT id, name, email, avatar_url, role, active FROM users WHERE id')) {
        return Promise.resolve({
          rows: [
            {
              id: 'user-123',
              name: 'Test User',
              email: 'test@example.com',
              avatar_url: null,
              role: 'user',
              active: false,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app)
      .post('/api/v1/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe('Account is deactivated');
  });

  it('should return 200 with valid user when token is valid', async () => {
    const token = getToken('user-123', 'user');
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          avatar_url: null,
          role: 'user',
          active: true,
        },
      ],
    });

    const response = await request(app)
      .post('/api/v1/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(true);
    expect(response.body.data.user).toBeDefined();
    expect(response.body.data.user.id).toBe('user-123');
    expect(response.body.data.user.email).toBe('test@example.com');
  });
});

describe('GET /api/v1/auth/me', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when no token is provided', async () => {
    const response = await request(app).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('No token provided');
  });

  it('should return 401 when token is invalid', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid or expired token');
  });

  it('should return 401 when user does not exist', async () => {
    const token = getToken('nonexistent-user', 'user');
    pool.query.mockResolvedValue({ rows: [] });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('User not found');
  });

  it('should return 403 when user is inactive', async () => {
    const token = getToken('user-123', 'user');
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          avatar_url: null,
          role: 'user',
          active: false,
          created_at: new Date(),
        },
      ],
    });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe('Account is deactivated');
  });

  it('should return 200 with user data when token is valid', async () => {
    const token = getToken('user-123', 'user');
    const createdAt = new Date();
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          avatar_url: null,
          role: 'user',
          active: true,
          created_at: createdAt,
        },
      ],
    });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toBeDefined();
    expect(response.body.data.id).toBe('user-123');
    expect(response.body.data.name).toBe('Test User');
    expect(response.body.data.email).toBe('test@example.com');
    expect(response.body.data.role).toBe('user');
    expect(response.body.data.active).toBe(true);
    expect(response.body.data.created_at).toBeDefined();
  });
});
