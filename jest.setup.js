/**
 * Jest setup file - runs before each test file.
 * Ensures JWT_SECRET is set so auth middleware and token verification work in tests.
 */
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
}
