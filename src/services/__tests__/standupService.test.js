/**
 * Tests for src/services/standupService.js
 */

const {
  generateDailyStandup,
  runStandupById,
  getAgentUsersForStandup,
  sendMessageToAgent,
  parseStandupResponse,
} = require('../standupService');

// Mock dependencies
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../activityLogService', () => ({
  recordActivityLogEventSafe: jest.fn(),
}));

jest.mock('../openclawGatewayClient', () => ({
  invokeTool: jest.fn(),
}));

const pool = require('../../db/pool');
const logger = require('../../utils/logger');
const { recordActivityLogEventSafe } = require('../activityLogService');
const { invokeTool } = require('../openclawGatewayClient');

describe('standupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseStandupResponse', () => {
    it('should parse complete standup response with all sections', () => {
      const response = `Yesterday: I worked on API integration
Today: Planning to work on UI components
Blockers: Need clarification on specs
Tasks: [{"id": "TASK-123", "title": "Fix bug"}]`;

      const result = parseStandupResponse(response);

      expect(result.yesterday).toBe('I worked on API integration');
      expect(result.today).toBe('Planning to work on UI components');
      expect(result.blockers).toBe('Need clarification on specs');
      expect(result.tasks).toEqual([{ id: 'TASK-123', title: 'Fix bug' }]);
      expect(result.raw).toBe(response);
    });

    it('should handle responses without sections by putting everything in today', () => {
      const response = 'Just a plain response without sections';

      const result = parseStandupResponse(response);

      expect(result.yesterday).toBeNull();
      expect(result.today).toBe('Just a plain response without sections');
      expect(result.blockers).toBeNull();
      expect(result.tasks).toBeNull();
    });

    it('should handle responses with only some sections', () => {
      const response = 'Yesterday: Worked on API\nToday: Will work on tests';

      const result = parseStandupResponse(response);

      expect(result.yesterday).toBe('Worked on API');
      expect(result.today).toBe('Will work on tests');
      expect(result.blockers).toBeNull();
    });

    it('should handle invalid JSON in tasks section', () => {
      const response = `Yesterday: Did work
Today: Will do more
Tasks: {"invalid": json}`;

      const result = parseStandupResponse(response);

      expect(result.yesterday).toBe('Did work');
      expect(result.today).toBe('Will do more');
      expect(result.tasks).toBeNull(); // Should be null after failed JSON parse
    });

    it('should return empty object for null/undefined response', () => {
      const result = parseStandupResponse(null);

      expect(result.yesterday).toBeNull();
      expect(result.today).toBeNull();
      expect(result.blockers).toBeNull();
      expect(result.tasks).toBeNull();
      expect(result.raw).toBeNull();
    });
  });

  describe('getAgentUsersForStandup', () => {
    it('should return agent users in correct order', async () => {
      const mockUsers = [
        { user_id: '1', name: 'CTO', agent_id: 'cto', avatar_url: null },
        { user_id: '2', name: 'CMO', agent_id: 'cmo', avatar_url: null },
        { user_id: '3', name: 'COO', agent_id: 'coo', avatar_url: null },
      ];
      pool.query.mockResolvedValueOnce({ rows: mockUsers });

      const result = await getAgentUsersForStandup();

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY ARRAY_POSITION'),
        expect.any(Array),
      );
      expect(result).toEqual(mockUsers);
    });

    it('should return empty array if no agent users found', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database error'));

      const result = await getAgentUsersForStandup();

      expect(logger.error).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should return empty array when database returns no results', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await getAgentUsersForStandup();

      expect(result).toEqual([]);
    });
  });

  describe('sendMessageToAgent', () => {
    it('should return null when sessions_send returns null', async () => {
      invokeTool.mockResolvedValueOnce(null);

      const result = await sendMessageToAgent('coo', 'Test message');

      expect(invokeTool).toHaveBeenCalledWith(
        'sessions_send',
        {
          sessionKey: 'agent:coo:main',
          message: 'Test message',
          timeoutSeconds: 120,
        },
        {
          sessionKey: 'main',
        },
      );
      expect(result).toBeNull();
      expect(recordActivityLogEventSafe).toHaveBeenCalled();
    });

    it('should return reply when sessions_send succeeds', async () => {
      invokeTool.mockResolvedValueOnce({
        status: 'ok',
        reply: 'Agent reply',
        runId: 'run-123',
      });

      const result = await sendMessageToAgent('cto', 'Test message', 90);

      expect(result).toBe('Agent reply');
      expect(recordActivityLogEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'adhoc_request',
          severity: 'info',
          agent_id: 'cto',
          meta: expect.objectContaining({
            outcome: 'ok',
            timeoutSeconds: 90,
          }),
        }),
      );
    });

    it('should return timeout message when sessions_send times out', async () => {
      invokeTool.mockResolvedValueOnce({
        status: 'timeout',
        runId: 'run-123',
      });

      const result = await sendMessageToAgent('cpo', 'Test message');

      expect(result).toBe('[Timeout after 120s — no response]');
      expect(recordActivityLogEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'adhoc_request',
          severity: 'warning',
          agent_id: 'cpo',
          meta: expect.objectContaining({
            outcome: 'timeout',
          }),
        }),
      );
    });

    it('should return error message when sessions_send returns error', async () => {
      invokeTool.mockResolvedValueOnce({
        status: 'error',
        error: 'Something went wrong',
      });

      const result = await sendMessageToAgent('cmo', 'Test message');

      expect(result).toBe('[Error: Something went wrong]');
      expect(recordActivityLogEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'adhoc_request',
          severity: 'error',
          agent_id: 'cmo',
          meta: expect.objectContaining({
            outcome: 'error',
            error: 'Something went wrong',
          }),
        }),
      );
    });

    it('should handle exceptions in tool invocation', async () => {
      invokeTool.mockRejectedValueOnce(new Error('Network error'));

      const result = await sendMessageToAgent('coo', 'Test message');

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalled();
      expect(recordActivityLogEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'adhoc_request',
          severity: 'error',
          agent_id: 'coo',
          meta: expect.objectContaining({
            outcome: 'exception',
            error: 'Network error',
          }),
        }),
      );
    });
  });

  describe('generateDailyStandup', () => {
    // Since this function calls multiple internal methods, we'll test error scenarios
    it('should handle errors gracefully and return error status', async () => {
      pool.query.mockRejectedValueOnce(new Error('DB connection failed'));

      const result = await generateDailyStandup('UTC');

      expect(result.status).toBe('error');
      expect(result.message).toBe('DB connection failed');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('runStandupById', () => {
    it('should return error status when no agents are found', async () => {
      const mockStandup = { id: 'standup-123', date: '2023-01-01' };
      pool.query.mockResolvedValueOnce({ rows: [] }); // For getAgentUsersForStandup

      const result = await runStandupById(mockStandup);

      expect(result.status).toBe('error');
      expect(result.message).toBe('No agent users found in the database');
      expect(logger.warn).toHaveBeenCalledWith('No agent users found for standup', {
        standupId: 'standup-123',
      });
    });

    it('should handle transaction rollback on error', async () => {
      const mockStandup = { id: 'standup-123', date: '2023-01-01' };
      const mockAgents = [{ user_id: '1', name: 'CTO', agent_id: 'cto', avatar_url: null }];

      pool.query
        .mockResolvedValueOnce({ rows: mockAgents }) // getAgentUsersForStandup
        .mockResolvedValueOnce({}) // UPDATE for status running
        .mockResolvedValueOnce({}) // DELETE entries
        .mockRejectedValueOnce(new Error('Transaction failed')); // This should trigger rollback

      const client = {
        query: jest
          .fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({}) // DELETE entries
          .mockResolvedValueOnce({}) // DELETE messages
          .mockRejectedValueOnce(new Error('Transaction failed')), // INSERT error
        release: jest.fn(),
      };

      pool.connect = jest.fn().mockResolvedValue(client);

      const result = await runStandupById(mockStandup);

      expect(result.status).toBe('error');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });
  });
});
