/**
 * Tests for src/jobs/runDailyStandup.js
 */

// Set up mocks with configurable timezone
let mockTimezone = 'UTC';
jest.mock('../../config', () => ({
  get timezone() {
    return mockTimezone;
  },
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../services/standupService', () => ({
  generateDailyStandup: jest.fn(),
}));

const runDailyStandup = require('../runDailyStandup');
const _config = require('../../config');
const logger = require('../../utils/logger');
const {
  generateDailyStandup: mockedGenerateDailyStandup,
} = require('../../services/standupService');

describe('runDailyStandup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTimezone = 'UTC'; // Reset to default
  });

  it('should call generateDailyStandup with correct timezone and log success', async () => {
    const mockResult = {
      status: 'completed',
      standupId: 'standup-123',
      agentCount: 3,
      durationMs: 5000,
    };

    mockedGenerateDailyStandup.mockResolvedValue(mockResult);

    const result = await runDailyStandup();

    expect(mockedGenerateDailyStandup).toHaveBeenCalledWith('UTC');
    expect(logger.info).toHaveBeenCalledWith('Daily standup job triggered', { timezone: 'UTC' });
    expect(logger.info).toHaveBeenCalledWith('Daily standup job completed successfully', {
      standupId: 'standup-123',
      agentCount: 3,
      durationMs: 5000,
    });
    expect(result).toEqual(mockResult);
  });

  it('should log error when standup generation fails', async () => {
    const mockResult = {
      status: 'error',
      message: 'Failed to connect to agents',
      durationMs: 1000,
    };

    mockedGenerateDailyStandup.mockResolvedValue(mockResult);

    const result = await runDailyStandup();

    expect(mockedGenerateDailyStandup).toHaveBeenCalledWith('UTC');
    expect(logger.error).toHaveBeenCalledWith('Daily standup job failed', {
      message: 'Failed to connect to agents',
      durationMs: 1000,
    });
    expect(result).toEqual(mockResult);
  });

  it('should handle exceptions and rethrow them', async () => {
    const mockError = new Error('Connection failed');
    mockedGenerateDailyStandup.mockRejectedValue(mockError);

    await expect(runDailyStandup()).rejects.toThrow('Connection failed');

    expect(logger.error).toHaveBeenCalledWith('Daily standup job error', {
      error: 'Connection failed',
      stack: expect.any(String),
    });
  });

  it('should pass timezone from config to generateDailyStandup', async () => {
    // Set timezone to New York for this test
    mockTimezone = 'America/New_York';

    // Need to re-require the function to pick up the new config
    jest.resetModules();
    const freshRunDailyStandup = require('../runDailyStandup');
    const {
      generateDailyStandup: freshGenerateDailyStandup,
    } = require('../../services/standupService');

    const mockResult = { status: 'completed', standupId: 'standup-456' };
    freshGenerateDailyStandup.mockResolvedValue(mockResult);

    await freshRunDailyStandup();

    expect(freshGenerateDailyStandup).toHaveBeenCalledWith('America/New_York');
  });
});
