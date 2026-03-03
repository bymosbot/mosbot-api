/**
 * Tests for jwt.js - JWT token signing and secret management
 */

const jwt = require('jsonwebtoken');
const { getJwtSecret, signToken } = require('../jwt');
const config = require('../../config');

// Mock config module
jest.mock('../../config', () => ({
  jwt: {
    secret: null,
    expiresIn: '7d',
  },
}));

describe('jwt utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset config.jwt.secret before each test
    config.jwt.secret = null;
    config.jwt.expiresIn = '7d';
  });

  describe('getJwtSecret()', () => {
    it('should return JWT secret when set', () => {
      config.jwt.secret = 'test-secret-key';
      expect(getJwtSecret()).toBe('test-secret-key');
    });

    it('should throw error when JWT_SECRET is not set', () => {
      config.jwt.secret = null;
      expect(() => {
        getJwtSecret();
      }).toThrow('JWT_SECRET environment variable is not set');
    });

    it('should throw error when JWT_SECRET is empty string', () => {
      config.jwt.secret = '';
      expect(() => {
        getJwtSecret();
      }).toThrow('JWT_SECRET environment variable is not set');
    });
  });

  describe('signToken()', () => {
    beforeEach(() => {
      config.jwt.secret = 'test-secret-key';
      config.jwt.expiresIn = '7d';
    });

    it('should sign token with user payload', () => {
      const payload = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user',
      };

      const result = signToken(payload);

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('expires_in');
      expect(result.expires_in).toBe('7d');

      // Verify token can be decoded
      const decoded = jwt.verify(result.token, 'test-secret-key');
      expect(decoded.id).toBe('user-123');
      expect(decoded.email).toBe('test@example.com');
      expect(decoded.name).toBe('Test User');
      expect(decoded.role).toBe('user');
    });

    it('should use expiresIn from config', () => {
      config.jwt.expiresIn = '30d';
      const payload = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user',
      };

      const result = signToken(payload);
      expect(result.expires_in).toBe('30d');
    });

    it('should throw error when JWT_SECRET is not set', () => {
      config.jwt.secret = null;
      const payload = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user',
      };

      expect(() => {
        signToken(payload);
      }).toThrow('JWT_SECRET environment variable is not set');
    });

    it('should include all payload fields in token', () => {
      const payload = {
        id: 'user-456',
        email: 'admin@example.com',
        name: 'Admin User',
        role: 'admin',
      };

      const result = signToken(payload);
      const decoded = jwt.verify(result.token, 'test-secret-key');

      expect(decoded).toMatchObject({
        id: 'user-456',
        email: 'admin@example.com',
        name: 'Admin User',
        role: 'admin',
      });
    });

    it('should include exp claim in token', () => {
      const payload = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        role: 'user',
      };

      const result = signToken(payload);
      const decoded = jwt.verify(result.token, 'test-secret-key');

      expect(decoded.exp).toBeDefined();
      expect(typeof decoded.exp).toBe('number');
      expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });
});
