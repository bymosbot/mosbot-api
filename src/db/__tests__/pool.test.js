/**
 * Tests for db/pool.js - Database connection pooling and configuration
 */

// We need to mock before the module is required
const mockPoolQuery = jest.fn();
const mockPoolOn = jest.fn();
const mockPoolConnect = jest.fn();
const mockPoolEnd = jest.fn();

// Create a mock Pool constructor
const mockPoolConstructor = jest.fn().mockImplementation((options) => ({
  query: mockPoolQuery,
  on: mockPoolOn,
  connect: mockPoolConnect,
  end: mockPoolEnd,
  options,
}));

// Create a mock for the types parser
const mockSetTypeParser = jest.fn();
const mockTypes = {
  setTypeParser: mockSetTypeParser,
};

// Mock the entire pg module
jest.mock('pg', () => ({
  Pool: mockPoolConstructor,
  types: mockTypes,
}));

// Mock the logger
jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const _logger = require('../../utils/logger');

describe('db pool initialization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset environment to a clean state
    process.env = { ...originalEnv };
    delete process.env.TEST_DB_HOST;
    delete process.env.TEST_DB_PORT;
    delete process.env.TEST_DB_NAME;
    delete process.env.TEST_DB_USER;
    delete process.env.TEST_DB_PASSWORD;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_NAME;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should configure timestamp type parser correctly', () => {
    // Need to re-require the module to trigger the side effects
    jest.isolateModules(() => {
      require('../pool');
    });

    expect(mockTypes.setTypeParser).toHaveBeenCalledWith(1114, expect.any(Function));

    // Test the actual parser function
    const parserFn = mockSetTypeParser.mock.calls.find((call) => call[0] === 1114)?.[1];
    if (parserFn) {
      expect(parserFn('2023-01-01 12:00:00')).toBe('2023-01-01 12:00:00');
    }
  });

  it('should create pool with default options when no environment variables are set', () => {
    // Re-require the module to trigger creation with clean environment
    jest.isolateModules(() => {
      require('../pool');
    });

    expect(mockPoolConstructor).toHaveBeenCalledWith({
      host: undefined,
      port: undefined,
      database: undefined,
      user: undefined,
      password: undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  });

  it('should use TEST_* environment variables when available', () => {
    process.env.TEST_DB_HOST = 'test-host';
    process.env.TEST_DB_PORT = '5433';
    process.env.TEST_DB_NAME = 'test-db';
    process.env.TEST_DB_USER = 'test-user';
    process.env.TEST_DB_PASSWORD = 'test-password';

    jest.isolateModules(() => {
      require('../pool');
    });

    expect(mockPoolConstructor).toHaveBeenCalledWith({
      host: 'test-host',
      port: '5433',
      database: 'test-db',
      user: 'test-user',
      password: 'test-password',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  });

  it('should fall back to DB_* environment variables when TEST_* are not set', () => {
    process.env.DB_HOST = 'regular-host';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'regular-db';
    process.env.DB_USER = 'regular-user';
    process.env.DB_PASSWORD = 'regular-password';

    jest.isolateModules(() => {
      require('../pool');
    });

    expect(mockPoolConstructor).toHaveBeenCalledWith({
      host: 'regular-host',
      port: '5432',
      database: 'regular-db',
      user: 'regular-user',
      password: 'regular-password',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  });

  it('should prioritize TEST_* over DB_* variables', () => {
    process.env.TEST_DB_HOST = 'test-host';
    process.env.TEST_DB_PORT = '5433';
    process.env.TEST_DB_NAME = 'test-db';
    process.env.TEST_DB_USER = 'test-user';
    process.env.TEST_DB_PASSWORD = 'test-password';

    process.env.DB_HOST = 'regular-host';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'regular-db';
    process.env.DB_USER = 'regular-user';
    process.env.DB_PASSWORD = 'regular-password';

    jest.isolateModules(() => {
      require('../pool');
    });

    expect(mockPoolConstructor).toHaveBeenCalledWith({
      host: 'test-host',
      port: '5433',
      database: 'test-db',
      user: 'test-user',
      password: 'test-password',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  });

  it('should register connect and error event handlers', () => {
    // Create a mock pool instance to test the event registration
    const mockPool = {
      on: jest.fn(),
    };

    mockPoolConstructor.mockReturnValue(mockPool);

    jest.isolateModules(() => {
      require('../pool');
    });

    // Check that both event handlers were registered
    expect(mockPool.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(mockPool.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
