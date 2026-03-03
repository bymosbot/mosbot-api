const mockGetFileContent = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock('../openclawWorkspaceClient', () => ({
  getFileContent: (...args) => mockGetFileContent(...args),
}));

jest.mock('../../db/pool', () => ({
  query: (...args) => mockPoolQuery(...args),
}));

jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
}));

const {
  parseJsonl,
  fetchRuntimeSubagents,
  enrichWithTaskNumbers,
  getAllSubagents,
  clearEmptyFileCache,
} = require('../subagentsRuntimeService');

describe('subagentsRuntimeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearEmptyFileCache();
  });

  describe('parseJsonl()', () => {
    it('returns empty array for non-string content', () => {
      expect(parseJsonl(null)).toEqual([]);
      expect(parseJsonl({})).toEqual([]);
    });

    it('parses valid lines and ignores malformed lines', () => {
      const content = [JSON.stringify({ a: 1 }), 'not-json', JSON.stringify({ b: 2 })].join('\n');
      expect(parseJsonl(content)).toEqual([{ a: 1 }, { b: 2 }]);
    });
  });

  describe('fetchRuntimeSubagents()', () => {
    it('swallows non-SERVICE_NOT_CONFIGURED file errors and returns empty data', async () => {
      mockGetFileContent.mockRejectedValue(new Error('transient read error'));

      await expect(fetchRuntimeSubagents()).resolves.toEqual({
        running: [],
        queued: [],
        completed: [],
        activityBySession: expect.any(Map),
      });
    });

    it('filters activity/results by taskId when entry taskId mismatches', async () => {
      mockGetFileContent
        // spawn-active.jsonl
        .mockResolvedValueOnce('')
        // spawn-requests.json
        .mockResolvedValueOnce('')
        // results-cache.jsonl
        .mockResolvedValueOnce(
          [
            JSON.stringify({
              sessionLabel: 'agent:coo:subagent:1',
              taskId: 'task-1',
              cachedAt: '2026-03-03T10:00:00.000Z',
              outcome: 'ok',
            }),
            JSON.stringify({
              sessionLabel: 'agent:coo:subagent:2',
              taskId: 'task-2',
              cachedAt: '2026-03-03T10:00:00.000Z',
              outcome: 'ok',
            }),
          ].join('\n'),
        )
        // activity-log.jsonl
        .mockResolvedValueOnce(
          [
            // Should be filtered out by taskId mismatch even though session_label matches.
            JSON.stringify({
              timestamp: '2026-03-03T09:59:00.000Z',
              task_id: 'task-2',
              metadata: { session_label: 'agent:coo:subagent:1' },
              event: 'agent_start',
            }),
          ].join('\n'),
        );

      const result = await fetchRuntimeSubagents({ taskId: 'task-1' });

      expect(result.completed).toHaveLength(1);
      expect(result.completed[0]).toMatchObject({
        sessionLabel: 'agent:coo:subagent:1',
        taskId: 'task-1',
      });
      // Activity event is intentionally filtered out due to mismatched task_id.
      expect(result.completed[0].startedAt).toBeNull();
    });
  });

  describe('enrichWithTaskNumbers()', () => {
    it('enriches rows with taskNumber from DB lookup', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 't1', task_number: 101 }],
      });

      const result = await enrichWithTaskNumbers(
        [{ taskId: 't1', status: 'RUNNING' }],
        [{ taskId: null, status: 'SPAWN_QUEUED' }],
        [{ taskId: 'missing', status: 'COMPLETED' }],
      );

      expect(result.running[0].taskNumber).toBe(101);
      expect(result.queued[0].taskNumber).toBeNull();
      expect(result.completed[0].taskNumber).toBeNull();
    });
  });

  describe('getAllSubagents()', () => {
    it('combines runtime fetch and DB enrichment', async () => {
      mockGetFileContent
        .mockResolvedValueOnce(
          JSON.stringify({
            sessionKey: 'k',
            sessionLabel: 's',
            taskId: 't1',
            model: 'x',
            startedAt: '2026-03-03T10:00:00.000Z',
            timeoutMinutes: 15,
          }),
        )
        .mockResolvedValueOnce(JSON.stringify({ requests: [] }))
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('');
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 't1', task_number: 7 }] });

      const result = await getAllSubagents();

      expect(result.running[0]).toMatchObject({
        taskId: 't1',
        taskNumber: 7,
      });
      expect(result.queued).toEqual([]);
      expect(result.completed).toEqual([]);
    });
  });
});
