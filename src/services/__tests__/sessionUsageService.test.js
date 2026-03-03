/**
 * Tests for src/services/sessionUsageService.js
 */

const {
  deriveAgentKeyFromSessionKey,
  extractModel,
  deriveJobIdFromSessionKey,
  toHourBucket,
  upsertSessionUsageBatch,
  syncSessionUsageFromGateway,
  startSessionUsagePoller,
} = require('../sessionUsageService');

// Mock dependencies
jest.mock('../../db/pool', () => ({
  connect: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../openclawGatewayClient', () => ({
  gatewayWsRpc: jest.fn(),
}));

const pool = require('../../db/pool');
const logger = require('../../utils/logger');
const { gatewayWsRpc } = require('../openclawGatewayClient');

describe('sessionUsageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('deriveAgentKeyFromSessionKey', () => {
    it('should return main for undefined/null input', () => {
      expect(deriveAgentKeyFromSessionKey(undefined)).toBe('main');
      expect(deriveAgentKeyFromSessionKey(null)).toBe('main');
    });

    it('should return main for non-string input', () => {
      expect(deriveAgentKeyFromSessionKey(123)).toBe('main');
      expect(deriveAgentKeyFromSessionKey({})).toBe('main');
    });

    it('should return main for basic session keys', () => {
      expect(deriveAgentKeyFromSessionKey('main')).toBe('main');
      expect(deriveAgentKeyFromSessionKey('other-key')).toBe('main');
    });

    it('should extract agent key from agent session keys', () => {
      expect(deriveAgentKeyFromSessionKey('agent:coo:main')).toBe('coo');
      expect(deriveAgentKeyFromSessionKey('agent:cto:subagent:uuid123')).toBe('cto');
      expect(deriveAgentKeyFromSessionKey('agent:cpo:cron:job123:run:sess123')).toBe('cpo');
    });
  });

  describe('extractModel', () => {
    it('should return null for invalid input', () => {
      expect(extractModel({})).toBeNull();
      expect(extractModel({ model: null })).toBeNull();
      expect(extractModel({ model: undefined })).toBeNull();
      expect(extractModel({ model: '' })).toBeNull();
      expect(extractModel({ model: '   ' })).toBeNull();
    });

    it('should handle model without provider', () => {
      expect(extractModel({ model: 'gpt-4' })).toBe('gpt-4');
      expect(extractModel({ model: ' claude-3 ' })).toBe('claude-3');
    });

    it('should handle model with provider prefix', () => {
      expect(extractModel({ model: 'gpt-4', modelProvider: 'openai' })).toBe('openai/gpt-4');
      expect(extractModel({ model: 'claude-3', modelProvider: 'anthropic' })).toBe(
        'anthropic/claude-3',
      );
    });

    it('should avoid duplicate prefixes', () => {
      expect(extractModel({ model: 'openai/gpt-4', modelProvider: 'openai' })).toBe('openai/gpt-4');
      expect(
        extractModel({ model: 'openrouter/openrouter/mistral', modelProvider: 'openrouter' }),
      ).toBe('openrouter/mistral');
    });

    it('should handle double prefixes correctly', () => {
      expect(
        extractModel({ model: 'openrouter/openrouter/mistral/large', modelProvider: 'openrouter' }),
      ).toBe('openrouter/mistral/large');
    });
  });

  describe('deriveJobIdFromSessionKey', () => {
    it('should return null for invalid inputs', () => {
      expect(deriveJobIdFromSessionKey(undefined)).toBeNull();
      expect(deriveJobIdFromSessionKey(null)).toBeNull();
      expect(deriveJobIdFromSessionKey('')).toBeNull();
      expect(deriveJobIdFromSessionKey('not-agent:coo:main')).toBeNull();
    });

    it('should return null for non-cron agent sessions', () => {
      expect(deriveJobIdFromSessionKey('agent:coo:main')).toBeNull();
      expect(deriveJobIdFromSessionKey('agent:cto:subagent:123')).toBeNull();
    });

    it('should extract job ID from cron sessions', () => {
      expect(deriveJobIdFromSessionKey('agent:coo:cron:job123:run:session123')).toBe('job123');
      expect(deriveJobIdFromSessionKey('agent:cto:cron:daily-sync')).toBe('daily-sync');
    });
  });

  describe('toHourBucket', () => {
    it('should truncate date to start of UTC hour', () => {
      const date = new Date('2023-01-01T14:32:45.123Z');
      const result = toHourBucket(date);

      expect(result.toISOString()).toBe('2023-01-01T14:00:00.000Z');
      expect(result.getUTCMinutes()).toBe(0);
      expect(result.getUTCSeconds()).toBe(0);
      expect(result.getUTCMilliseconds()).toBe(0);
    });

    it('should preserve the date and hour parts', () => {
      const date = new Date('2023-05-15T09:47:33.555Z');
      const result = toHourBucket(date);

      expect(result.getUTCFullYear()).toBe(2023);
      expect(result.getUTCMonth()).toBe(4); // May is 4
      expect(result.getUTCDate()).toBe(15);
      expect(result.getUTCHours()).toBe(9);
    });
  });

  describe('syncSessionUsageFromGateway', () => {
    it('should call gateway with correct parameters', async () => {
      const today = new Date().toISOString().slice(0, 10);
      gatewayWsRpc.mockResolvedValue({ sessions: [] });

      await syncSessionUsageFromGateway();

      expect(gatewayWsRpc).toHaveBeenCalledWith('sessions.usage', {
        startDate: today,
        endDate: today,
        limit: 1000,
      });
    });

    it('should return 0 when no sessions returned', async () => {
      gatewayWsRpc.mockResolvedValue({ sessions: [] });

      const result = await syncSessionUsageFromGateway();

      expect(result).toBe(0);
    });

    it('should call upsertSessionUsageBatch when sessions returned', async () => {
      const mockSessions = [
        { key: 'session1', usage: { totalCost: 0.1 } },
        { key: 'session2', usage: { totalCost: 0.2 } },
      ];
      gatewayWsRpc.mockResolvedValue({ sessions: mockSessions });

      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };
      pool.connect.mockResolvedValue(mockClient);

      const result = await syncSessionUsageFromGateway();

      expect(result).toBe(mockSessions.length);
      expect(pool.connect).toHaveBeenCalled();
    });
  });

  describe('startSessionUsagePoller', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should run tick immediately and schedule interval', async () => {
      gatewayWsRpc.mockResolvedValue({ sessions: [] });

      const handle = startSessionUsagePoller(1000);

      // Should have run once immediately
      expect(gatewayWsRpc).toHaveBeenCalledTimes(1);

      // Advance timer to trigger interval
      jest.advanceTimersByTime(1000);
      expect(gatewayWsRpc).toHaveBeenCalledTimes(2);

      // Stop the poller
      handle.stop();
    });

    it('should handle sync errors gracefully', async () => {
      gatewayWsRpc.mockRejectedValue(new Error('Network error'));

      startSessionUsagePoller(1000);

      // Flush microtasks so the async tick() catch block can run
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.warn).toHaveBeenCalledWith(
        'Session usage poller: sync failed',
        expect.objectContaining({ error: 'Network error' }),
      );
    });

    it('should handle SERVICE_NOT_CONFIGURED error specially', async () => {
      gatewayWsRpc.mockRejectedValue({ code: 'SERVICE_NOT_CONFIGURED', message: 'Not configured' });

      startSessionUsagePoller(1000);

      // Should not log a warning for SERVICE_NOT_CONFIGURED
      const warnCalls = logger.warn.mock.calls;
      const serviceNotConfiguredLogs = warnCalls.filter(
        (call) => call[0] === 'Session usage poller: sync failed',
      );
      expect(serviceNotConfiguredLogs).toHaveLength(0);
    });
  });

  describe('upsertSessionUsageBatch', () => {
    it('should handle empty batch', async () => {
      await upsertSessionUsageBatch([]);

      // Function returns early for empty batch without acquiring a connection
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('should handle batch with null/undefined keys', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };
      pool.connect.mockResolvedValue(mockClient);

      await upsertSessionUsageBatch([
        { key: null, usage: { totalCost: 0.1 } },
        { key: undefined, usage: { totalCost: 0.2 } },
        { key: 'valid-session', usage: { totalCost: 0.3 } },
      ]);

      // Should only process the valid session key
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO session_usage'),
        expect.arrayContaining(['valid-session']),
      );
    });
  });
});
