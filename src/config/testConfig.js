// Configuration for OpenClaw services that allows for faster test execution
const _config = require('../config');
const _logger = require('../utils/logger');

// Determine if we're in test mode for setting appropriate timeout values
const isTestEnvironment =
  process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

// Faster timeout settings for tests
const TEST_RETRY_SETTINGS = {
  maxRetries: 1, // Reduce from 3 to 1 for faster test failure
  baseDelayMs: 10, // Reduce from 500ms to 10ms for tests
  gatewayTimeoutMs: 2000, // Reduce from 15000ms to 2000ms for tests
};

// Production/default settings
const DEFAULT_RETRY_SETTINGS = {
  maxRetries: 3,
  baseDelayMs: 500,
  gatewayTimeoutMs: 15000,
};

// Use test settings when in test mode, otherwise default settings
const RETRY_SETTINGS = isTestEnvironment ? TEST_RETRY_SETTINGS : DEFAULT_RETRY_SETTINGS;

module.exports = {
  RETRY_SETTINGS,
  isTestEnvironment,
};
