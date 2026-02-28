const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Returns the JWT secret from config.
 * Throws if the variable is not set so callers can propagate the error
 * via next(err) or a 500 response rather than silently using an undefined key.
 *
 * @returns {string}
 * @throws {Error}
 */
function getJwtSecret() {
  const secret = config.jwt.secret;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

/**
 * Sign a JWT for the given user payload.
 *
 * @param {{ id: string, email: string, name: string, role: string }} payload
 * @returns {{ token: string, expires_in: string }}
 */
function signToken(payload) {
  const secret = getJwtSecret();
  const expires_in = config.jwt.expiresIn;
  const token = jwt.sign(payload, secret, { expiresIn: expires_in });
  return { token, expires_in };
}

module.exports = { getJwtSecret, signToken };
