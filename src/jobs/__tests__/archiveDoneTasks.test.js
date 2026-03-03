/**
 * Tests for src/jobs/archiveDoneTasks.js
 */

const archiveDoneTasks = require('../archiveDoneTasks');

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

const pool = require('../../db/pool');
const logger = require('../../utils/logger');

describe('archiveDoneTasks', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    pool.connect.mockResolvedValue(mockClient);
  });

  it('should return 0 when advisory lock is already taken', async () => {
    // Simulate that the lock is not acquired
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });

    const result = await archiveDoneTasks();

    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [123456789],
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Archive job already running on another instance, skipping...',
    );
    expect(result).toBe(0);
  });

  it('should acquire lock, archive tasks, and release lock when tasks need archiving', async () => {
    const mockArchivedTasks = [
      { id: 'task-1', title: 'Task 1', done_at: '2023-01-01' },
      { id: 'task-2', title: 'Task 2', done_at: '2023-01-01' },
    ];

    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // Lock acquisition
      .mockResolvedValueOnce({}) // Begin transaction
      .mockResolvedValueOnce({ rows: [] }) // Backfill query (empty result)
      .mockResolvedValueOnce({ rows: mockArchivedTasks }) // Archive query
      .mockResolvedValueOnce({}) // INSERT log for task-1
      .mockResolvedValueOnce({}) // INSERT log for task-2
      .mockResolvedValueOnce({}) // Commit transaction
      .mockResolvedValueOnce({ rows: [] }); // Unlock

    const result = await archiveDoneTasks(7);

    // Verify lock was acquired
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [123456789],
    );

    // Verify transaction was started
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');

    // Verify the backfill query was called with correct parameter
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('done_at = updated_at'),
      [],
    );

    // Verify the archive query was called with the correct parameter
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'ARCHIVE'"),
      [7],
    );

    // Verify transaction was committed
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');

    // Verify lock was released
    expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [123456789]);

    expect(logger.info).toHaveBeenCalledWith(`Archived ${mockArchivedTasks.length} task(s)`, {
      count: mockArchivedTasks.length,
    });
    expect(result).toBe(mockArchivedTasks.length);
  });

  it('should handle case when no tasks need archiving', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // Lock acquisition
      .mockResolvedValueOnce({ rows: [] }) // Backfill query
      .mockResolvedValueOnce({ rows: [] }) // Archive query (no results)
      .mockResolvedValueOnce({}) // Begin transaction
      .mockResolvedValueOnce({}) // Commit transaction
      .mockResolvedValueOnce({ rows: [] }); // Unlock

    const result = await archiveDoneTasks(7);

    expect(logger.info).toHaveBeenCalledWith('No tasks to archive');
    expect(result).toBe(0);
  });

  it('should handle transaction errors and rollback', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // Lock acquisition
      .mockResolvedValueOnce({ rows: [] }) // Backfill query
      .mockRejectedValueOnce(new Error('Database error')); // Archive query fails

    await expect(archiveDoneTasks(7)).rejects.toThrow('Database error');

    // Verify rollback was called
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');

    // Verify lock was released even after error
    expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [123456789]);

    // Verify error was logged
    expect(logger.error).toHaveBeenCalledWith('Archive job failed', { error: 'Database error' });
  });

  it('should handle lock release failure gracefully', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // Lock acquisition
      .mockResolvedValueOnce({ rows: [] }) // Backfill query
      .mockResolvedValueOnce({ rows: [] }) // Archive query
      .mockResolvedValueOnce({}) // Begin transaction
      .mockResolvedValueOnce({}) // Commit transaction
      .mockRejectedValueOnce(new Error('Lock release failed')); // Unlock fails at the end

    // The function should still complete normally despite lock release failure
    const result = await archiveDoneTasks(7);

    // Verify error was logged but no exception thrown
    expect(logger.error).toHaveBeenCalledWith('Failed to release advisory lock', {
      error: 'Lock release failed',
    });
    expect(result).toBe(0);
  });

  it('should use default archiveAfterDays when not provided', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // Lock acquisition
      .mockResolvedValueOnce({ rows: [] }) // Backfill query
      .mockResolvedValueOnce({ rows: [] }) // Archive query
      .mockResolvedValueOnce({}) // Begin transaction
      .mockResolvedValueOnce({}) // Commit transaction
      .mockResolvedValueOnce({ rows: [] }); // Unlock

    await archiveDoneTasks(); // Call without parameter

    // Find the call that contains the archive query and verify it was called with default value of 7
    const archiveQueryCalls = mockClient.query.mock.calls.filter(
      (call) => call[0] && call[0].includes("SET status = 'ARCHIVE'"),
    );

    expect(archiveQueryCalls).toHaveLength(1);
    expect(archiveQueryCalls[0]).toEqual([
      expect.stringContaining("SET status = 'ARCHIVE'"),
      [7], // Default value
    ]);
  });
});
