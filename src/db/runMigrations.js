require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const logger = require('../utils/logger');

// Postgres advisory lock ID for migrations (unique 64-bit integer)
// Different from ARCHIVER_LOCK_ID (123456789) to avoid conflicts
const MIGRATIONS_LOCK_ID = 987654321;

/**
 * Automated Migration Runner
 *
 * This runner:
 * 1. Acquires an advisory lock to prevent concurrent execution across instances
 * 2. Ensures the schema_migrations table exists (bootstrap)
 * 3. Scans src/db/migrations/ for *.sql files
 * 4. Sorts by filename (e.g., 000_*, 001_*, 002_*)
 * 5. For each file not in the tracking table: runs it in a transaction, then records it
 * 6. Logs which migrations were applied
 */

async function ensureMigrationsTable(client) {
  // Check if schema_migrations table exists
  const tableExists = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schema_migrations' LIMIT 1`
  );

  if (tableExists.rows.length === 0) {
    logger.info('Creating schema_migrations tracking table');

    // Create the migrations table
    await client.query(`
      CREATE TABLE schema_migrations (
        id SERIAL PRIMARY KEY,
        version VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX idx_schema_migrations_version ON schema_migrations(version);
      CREATE INDEX idx_schema_migrations_applied_at ON schema_migrations(applied_at DESC);
    `);

    logger.info('schema_migrations table created');
  }
}

async function getAppliedMigrations(client) {
  const result = await client.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  return new Set(result.rows.map((row) => row.version));
}

async function getMigrationFiles() {
  const migrationsDir = path.join(__dirname, 'migrations');

  // Ensure migrations directory exists
  if (!fs.existsSync(migrationsDir)) {
    logger.info('Creating migrations directory');
    fs.mkdirSync(migrationsDir, { recursive: true });
    return [];
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort(); // Sort alphabetically (e.g., 000_*, 001_*, 002_*)

  return files;
}

async function runMigration(client, filename, sql) {
  logger.info(`Running migration: ${filename}`);

  try {
    // Run migration in a transaction
    await client.query('BEGIN');

    // Execute the migration SQL
    await client.query(sql);

    // Record the migration as applied
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
      filename,
    ]);

    await client.query('COMMIT');
    logger.info(`Applied migration: ${filename}`);
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to apply migration: ${filename}`, { error: error.message });
    throw error;
  }
}

async function runMigrations(options = {}) {
  const { endPool = true } = options;
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    // Step 0: Try to acquire advisory lock (non-blocking)
    // This prevents multiple instances from running migrations simultaneously
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [MIGRATIONS_LOCK_ID]);
    
    if (!lockResult.rows[0].acquired) {
      logger.info('Migrations already running on another instance, skipping...');
      return;
    }
    
    lockAcquired = true;
    logger.info('Acquired advisory lock for migrations');

    logger.info('Running database migrations');

    // Step 1: Ensure migrations table exists
    await ensureMigrationsTable(client);

    // Step 2: Get list of applied migrations
    const appliedMigrations = await getAppliedMigrations(client);

    // Step 3: Get list of migration files
    const migrationFiles = await getMigrationFiles();

    if (migrationFiles.length === 0) {
      logger.info('No migration files found in src/db/migrations/');
      return;
    }

    // Step 4: Filter pending migrations
    const pendingMigrations = migrationFiles.filter(
      (file) => !appliedMigrations.has(file)
    );

    if (pendingMigrations.length === 0) {
      logger.info('All migrations up to date (0 pending)');
      return;
    }

    logger.info(`Found ${pendingMigrations.length} pending migration(s)`, { migrations: pendingMigrations });

    // Step 5: Run pending migrations in order
    const appliedCount = [];
    for (const filename of pendingMigrations) {
      const migrationPath = path.join(__dirname, 'migrations', filename);
      const sql = fs.readFileSync(migrationPath, 'utf-8');

      await runMigration(client, filename, sql);
      appliedCount.push(filename);
    }

    logger.info(`Successfully applied ${appliedCount.length} migration(s)`, { migrations: appliedCount });
  } catch (error) {
    logger.error('Migration failed', { error: error.message });
    throw error;
  } finally {
    // Release advisory lock if we acquired it
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_ID]);
        logger.info('Released advisory lock for migrations');
      } catch (unlockError) {
        logger.error('Failed to release advisory lock', { error: unlockError.message });
      }
    }
    
    client.release();
    if (endPool) {
      await pool.end();
    }
  }
}

// Allow running directly or as a module
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = runMigrations;
