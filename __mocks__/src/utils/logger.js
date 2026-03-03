/**
 * Mock logger for testing - suppresses all console output
 */

// Create a mock logger that does nothing
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// Export the mock logger functions
module.exports = mockLogger;