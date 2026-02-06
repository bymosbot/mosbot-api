/**
 * Unit tests for migration runner
 * 
 * These tests verify that the migration runner:
 * - Acquires advisory lock before running migrations
 * - Skips if lock is already acquired (another instance running)
 * - Creates schema_migrations table if it doesn't exist
 * - Runs only pending migrations
 * - Handles migration failures correctly
 * - Releases lock properly
 */

const fs = require('fs');

// Mock fs before requiring runMigrations
jest.mock('fs');
jest.mock('../../db/pool', () => ({
  connect: jest.fn(),
  end: jest.fn()
}));

const pool = require('../../db/pool');
const runMigrations = require('../runMigrations');

describe('Migration Runner', () => {
  let mockClient;
  let mockQuery;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock client with query method
    mockQuery = jest.fn();
    mockClient = {
      query: mockQuery,
      release: jest.fn()
    };
    
    pool.connect.mockResolvedValue(mockClient);
    
    // Mock fs.existsSync and readdirSync
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['000_bootstrap.sql', '001_initial_schema.sql']);
    fs.readFileSync.mockImplementation((filePath) => {
      if (filePath.includes('000_bootstrap.sql')) {
        return 'CREATE TABLE test_table (id SERIAL PRIMARY KEY);';
      }
      if (filePath.includes('001_initial_schema.sql')) {
        return 'CREATE TABLE users (id UUID PRIMARY KEY);';
      }
      return '';
    });
    fs.mkdirSync.mockImplementation(() => {});
  });

  describe('Advisory Lock', () => {
    it('should acquire advisory lock before running migrations', async () => {
      // Mock: lock acquired, table exists, no pending migrations
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [{ version: '000_bootstrap.sql' }, { version: '001_initial_schema.sql' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Verify lock was attempted
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('pg_try_advisory_lock'),
        expect.arrayContaining([987654321])
      );
    });

    it('should skip migrations if lock is already acquired', async () => {
      // Mock: lock not acquired
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: false }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Should only call lock query, nothing else
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('pg_try_advisory_lock'),
        expect.any(Array)
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release advisory lock after successful migrations', async () => {
      // Mock: lock acquired, table exists, no pending migrations
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [{ version: '000_bootstrap.sql' }, { version: '001_initial_schema.sql' }] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Verify lock was released
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_unlock'),
        expect.arrayContaining([987654321])
      );
    });

    it('should release advisory lock even on error', async () => {
      // Mock: lock acquired, but error occurs
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          throw new Error('Database connection error');
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(runMigrations({ endPool: false })).rejects.toThrow();

      // Verify lock was released even on error
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_unlock'),
        expect.any(Array)
      );
    });
  });

  describe('Schema Migrations Table', () => {
    it('should create schema_migrations table if it does not exist', async () => {
      // Mock: lock acquired, table does not exist
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [] }); // Table doesn't exist
        }
        if (query.includes('CREATE TABLE schema_migrations')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Verify CREATE TABLE was called
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE schema_migrations')
      );
    });

    it('should not create schema_migrations table if it already exists', async () => {
      // Mock: lock acquired, table exists
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] }); // Table exists
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Verify CREATE TABLE was NOT called
      const createTableCalls = mockQuery.mock.calls.filter(call => 
        call[0] && call[0].includes('CREATE TABLE schema_migrations')
      );
      expect(createTableCalls).toHaveLength(0);
    });
  });

  describe('Migration Execution', () => {
    it('should run pending migrations', async () => {
      // Mock: lock acquired, table exists, one pending migration
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [{ version: '000_bootstrap.sql' }] }); // Only one applied
        }
        if (query.includes('BEGIN')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('COMMIT')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('INSERT INTO schema_migrations')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Verify migration SQL was executed (via BEGIN/COMMIT)
      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE users'));
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO schema_migrations'),
        expect.arrayContaining(['001_initial_schema.sql'])
      );
    });

    it('should skip already applied migrations', async () => {
      // Mock: lock acquired, table exists, all migrations applied
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ 
            rows: [
              { version: '000_bootstrap.sql' }, 
              { version: '001_initial_schema.sql' }
            ] 
          }); // All applied
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Verify no migrations were executed (no BEGIN/COMMIT)
      const beginCalls = mockQuery.mock.calls.filter(call => call[0] === 'BEGIN');
      expect(beginCalls).toHaveLength(0);
    });

    it('should handle migration failure and rollback', async () => {
      // Mock: lock acquired, table exists, migration fails
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [{ version: '000_bootstrap.sql' }] });
        }
        if (query.includes('BEGIN')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('CREATE TABLE users')) {
          throw new Error('Syntax error in migration');
        }
        if (query.includes('ROLLBACK')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(runMigrations({ endPool: false })).rejects.toThrow('Syntax error in migration');

      // Verify rollback was called
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      // Verify migration was not recorded
      const insertCalls = mockQuery.mock.calls.filter(call => 
        call[0] && call[0].includes('INSERT INTO schema_migrations')
      );
      expect(insertCalls).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty migrations directory', async () => {
      fs.readdirSync.mockReturnValue([]);

      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Should complete without errors
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should create migrations directory if it does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      // Verify directory was created
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('migrations'),
        { recursive: true }
      );
    });

    it('should end pool when endPool option is true', async () => {
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [{ version: '000_bootstrap.sql' }, { version: '001_initial_schema.sql' }] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: true });

      expect(pool.end).toHaveBeenCalled();
    });

    it('should not end pool when endPool option is false', async () => {
      mockQuery.mockImplementation((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve({ rows: [{ acquired: true }] });
        }
        if (query.includes('information_schema.tables')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        }
        if (query.includes('SELECT version FROM schema_migrations')) {
          return Promise.resolve({ rows: [{ version: '000_bootstrap.sql' }, { version: '001_initial_schema.sql' }] });
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await runMigrations({ endPool: false });

      expect(pool.end).not.toHaveBeenCalled();
    });
  });
});
