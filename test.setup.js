// test.setup.js - Setup file to mock console methods during tests
// This file is used to suppress all console output during test runs

// Mock console methods to suppress logging during tests
global.console = {
  ...global.console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};