/**
 * Tests for src/utils/logger.js
 */

// Mock console methods to capture logs
const mockConsoleLog = jest.fn();
const mockConsoleWarn = jest.fn();
const mockConsoleError = jest.fn();
const mockConsoleDebug = jest.fn();

global.console = {
  log: mockConsoleLog,
  warn: mockConsoleWarn,
  error: mockConsoleError,
  debug: mockConsoleDebug,
};

const logger = require('../logger');

describe('logger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('info', () => {
    it('should log info message with timestamp', () => {
      const message = 'Test info message';
      const metadata = { userId: '123' };

      logger.info(message, metadata);

      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      const loggedMessage = mockConsoleLog.mock.calls[0][0];

      // Parse the JSON string that was logged
      const logEntry = JSON.parse(loggedMessage);
      expect(logEntry.level).toBe('INFO');
      expect(logEntry.message).toBe(message);
      expect(logEntry.userId).toBe('123');
      expect(Date.parse(logEntry.timestamp)).not.toBeNaN(); // Should be a valid date string
    });

    it('should work with just message', () => {
      const message = 'Simple info message';

      logger.info(message);

      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      const loggedMessage = mockConsoleLog.mock.calls[0][0];
      const logEntry = JSON.parse(loggedMessage);

      expect(logEntry.level).toBe('INFO');
      expect(logEntry.message).toBe(message);
      expect(Date.parse(logEntry.timestamp)).not.toBeNaN();
    });
  });

  describe('warn', () => {
    it('should log warning message to console.warn', () => {
      const message = 'Test warning';

      logger.warn(message);

      expect(mockConsoleWarn).toHaveBeenCalledTimes(1);
      const loggedMessage = mockConsoleWarn.mock.calls[0][0];
      const logEntry = JSON.parse(loggedMessage);

      expect(logEntry.level).toBe('WARN');
      expect(logEntry.message).toBe(message);
      expect(Date.parse(logEntry.timestamp)).not.toBeNaN();
    });
  });

  describe('error', () => {
    it('should log error message to console.error', () => {
      const message = 'Test error';

      logger.error(message);

      expect(mockConsoleError).toHaveBeenCalledTimes(1);
      const loggedMessage = mockConsoleError.mock.calls[0][0];
      const logEntry = JSON.parse(loggedMessage);

      expect(logEntry.level).toBe('ERROR');
      expect(logEntry.message).toBe(message);
      expect(Date.parse(logEntry.timestamp)).not.toBeNaN();
    });
  });

  describe('debug', () => {
    it('should log debug message to console.debug', () => {
      const message = 'Test debug';

      logger.debug(message);

      expect(mockConsoleDebug).toHaveBeenCalledTimes(1);
      const loggedMessage = mockConsoleDebug.mock.calls[0][0];
      const logEntry = JSON.parse(loggedMessage);

      expect(logEntry.level).toBe('DEBUG');
      expect(logEntry.message).toBe(message);
      expect(Date.parse(logEntry.timestamp)).not.toBeNaN();
    });
  });

  describe('log function', () => {
    it('should map levels correctly to console methods', () => {
      // Test all levels to make sure they use the right console method
      logger.info('info test');
      logger.warn('warn test');
      logger.error('error test');
      logger.debug('debug test');

      expect(mockConsoleLog).toHaveBeenCalledTimes(1); // info uses console.log by default
      expect(mockConsoleWarn).toHaveBeenCalledTimes(1);
      expect(mockConsoleError).toHaveBeenCalledTimes(1);
      expect(mockConsoleDebug).toHaveBeenCalledTimes(1);
    });

    it('should include all metadata properties', () => {
      const metadata = {
        userId: 'user-123',
        action: 'login',
        timestamp: 'custom-timestamp',
        extra: { nested: 'data' },
      };

      logger.info('Action occurred', metadata);

      const loggedMessage = mockConsoleLog.mock.calls[0][0];
      const logEntry = JSON.parse(loggedMessage);

      expect(logEntry.userId).toBe('user-123');
      expect(logEntry.action).toBe('login');
      expect(logEntry.timestamp).toBe('custom-timestamp'); // Note: original metadata timestamp is preserved
      expect(logEntry.extra).toEqual({ nested: 'data' });
    });

    it('should handle non-object metadata gracefully', () => {
      logger.info('Test message', 'string-metadata');

      // Even with invalid metadata, should still produce a log entry
      const loggedMessage = mockConsoleLog.mock.calls[0][0];
      const logEntry = JSON.parse(loggedMessage);

      expect(logEntry.level).toBe('INFO');
      expect(logEntry.message).toBe('Test message');
    });
  });
});
