const mockQuery = jest.fn();

jest.mock('../../db/pool', () => ({
  query: (...args) => mockQuery(...args),
}));

const {
  recordActivityLogEvent,
  recordActivityLogEventSafe,
  VALID_EVENT_TYPES,
  VALID_SEVERITIES,
  VALID_SOURCES,
} = require('../activityLogService');

describe('activityLogService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('recordActivityLogEvent()', () => {
    it('inserts a valid event and returns inserted row', async () => {
      const inserted = { id: 'row-1', title: 'Hello' };
      mockQuery.mockResolvedValueOnce({ rows: [inserted] });

      const timestamp = new Date('2026-03-03T00:00:00.000Z');
      const result = await recordActivityLogEvent({
        event_type: 'task_executed',
        source: 'task',
        title: 'Hello',
        description: 'World',
        severity: 'warning',
        agent_id: 'coo',
        task_id: 'task-1',
        job_id: 'job-1',
        session_key: 'main',
        run_id: 'run-1',
        workspace_path: '/x/y',
        meta: { a: 1 },
        dedupe_key: 'dedupe-1',
        actor_user_id: 'user-1',
        category: 'legacy',
        timestamp,
      });

      expect(result).toEqual(inserted);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, values] = mockQuery.mock.calls[0];
      expect(values[0]).toBe('Hello');
      expect(values[1]).toBe('World');
      expect(values[2]).toBe('legacy');
      expect(values[3]).toBe('coo');
      expect(values[4]).toBe('task-1');
      expect(values[5]).toBe(timestamp);
      expect(values[6]).toBe('task_executed');
      expect(values[7]).toBe('warning');
      expect(values[8]).toBe('task');
      expect(values[9]).toBe('user-1');
      expect(values[10]).toBe('job-1');
      expect(values[11]).toBe('main');
      expect(values[12]).toBe('run-1');
      expect(values[13]).toBe('/x/y');
      expect(values[14]).toBe(JSON.stringify({ a: 1 }));
      expect(values[15]).toBe('dedupe-1');
    });

    it('returns null when deduplicated insert returns no row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(
        recordActivityLogEvent({
          event_type: 'system',
          source: 'system',
          title: 'x',
        }),
      ).resolves.toBeNull();
    });

    it('uses defaults for omitted optional fields and trims title to 500 chars', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ok' }] });
      const longTitle = 't'.repeat(510);

      await recordActivityLogEvent({
        event_type: 'legacy',
        source: 'system',
        title: longTitle,
      });

      const [, values] = mockQuery.mock.calls[0];
      expect(values[0]).toHaveLength(500);
      expect(values[1]).toBe('');
      expect(values[7]).toBe('info');
      expect(values[14]).toBeNull();
    });

    it('throws for invalid event_type', async () => {
      await expect(
        recordActivityLogEvent({
          event_type: 'invalid_event',
          source: 'task',
          title: 'x',
        }),
      ).rejects.toThrow('invalid event_type');
    });

    it('throws for invalid severity', async () => {
      await expect(
        recordActivityLogEvent({
          event_type: 'task_executed',
          source: 'task',
          title: 'x',
          severity: 'critical',
        }),
      ).rejects.toThrow('invalid severity');
    });

    it('throws for invalid source', async () => {
      await expect(
        recordActivityLogEvent({
          event_type: 'task_executed',
          source: 'random',
          title: 'x',
        }),
      ).rejects.toThrow('invalid source');
    });

    it('throws when title is missing or blank', async () => {
      await expect(
        recordActivityLogEvent({
          event_type: 'task_executed',
          source: 'task',
          title: '',
        }),
      ).rejects.toThrow('title is required');

      await expect(
        recordActivityLogEvent({
          event_type: 'task_executed',
          source: 'task',
          title: '   ',
        }),
      ).rejects.toThrow('title is required');
    });
  });

  describe('recordActivityLogEventSafe()', () => {
    it('returns inserted row on success', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'safe-1' }] });

      await expect(
        recordActivityLogEventSafe({
          event_type: 'system',
          source: 'system',
          title: 'safe',
        }),
      ).resolves.toEqual({ id: 'safe-1' });
    });

    it('logs and returns null on failure', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockQuery.mockRejectedValueOnce(new Error('db down'));

      await expect(
        recordActivityLogEventSafe({
          event_type: 'system',
          source: 'system',
          title: 'safe',
        }),
      ).resolves.toBeNull();

      expect(spy).toHaveBeenCalledWith(
        '[activityLogService] Failed to record event:',
        'db down',
        expect.objectContaining({ title: 'safe' }),
      );
      spy.mockRestore();
    });
  });

  it('exports validation sets with expected values', () => {
    expect(VALID_EVENT_TYPES.has('task_executed')).toBe(true);
    expect(VALID_SEVERITIES.has('attention')).toBe(true);
    expect(VALID_SOURCES.has('workspace')).toBe(true);
  });
});
