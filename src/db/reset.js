require('dotenv').config();
const readline = require('readline');
const pool = require('./pool');
const runMigrations = require('./runMigrations');
const logger = require('../utils/logger');

// Safety checks
function isProductionEnvironment() {
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  const dbName = process.env.DB_NAME?.toLowerCase();
  const dbHost = process.env.DB_HOST?.toLowerCase();

  // Check NODE_ENV
  if (nodeEnv === 'production') {
    return true;
  }

  // Check for production-like database names
  if (dbName && (dbName.includes('prod') || dbName.includes('production'))) {
    return true;
  }

  // Check for production-like hosts (not localhost)
  if (
    dbHost &&
    dbHost !== 'localhost' &&
    dbHost !== '127.0.0.1' &&
    !dbHost.startsWith('postgres')
  ) {
    return true;
  }

  return false;
}

function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

async function confirmReset() {
  const isProd = isProductionEnvironment();
  const dbName = process.env.DB_NAME || 'unknown';
  const dbHost = process.env.DB_HOST || 'unknown';

  logger.warn('WARNING: Database Reset', {
    database: dbName,
    host: dbHost,
    environment: process.env.NODE_ENV || 'development'
  });

  if (isProd) {
    logger.warn('PRODUCTION ENVIRONMENT DETECTED - This will DELETE ALL DATA in the production database!');

    // Check for --force flag
    const hasForceFlag = process.argv.includes('--force');

    if (!hasForceFlag) {
      logger.error('Reset blocked: Production environment detected', {
        message: 'To proceed, you must use: npm run db:reset -- --force AND confirm when prompted'
      });
      process.exit(1);
    }

    // Double confirmation for production
    const confirm1 = await askConfirmation(
      '⚠️  Type "RESET PRODUCTION" (all caps) to confirm: '
    );

    if (confirm1 !== 'reset production') {
      logger.warn('Reset cancelled - confirmation did not match');
      process.exit(0);
    }

    const confirm2 = await askConfirmation(
      '⚠️  Type the database name to confirm: '
    );

    if (confirm2 !== dbName.toLowerCase()) {
      logger.warn('Reset cancelled - database name did not match');
      process.exit(0);
    }
  } else {
    logger.warn('This will DELETE ALL DATA in the database!');

    const confirm = await askConfirmation('Type "yes" to confirm: ');

    if (confirm !== 'yes') {
      logger.warn('Reset cancelled');
      process.exit(0);
    }
  }

  // Final countdown
  logger.info('Starting reset in 3 seconds... Press Ctrl+C to cancel');

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

async function reset() {
  let client;
  let clientReleased = false;

  try {
    client = await pool.connect();
    logger.info('Resetting database...');

    // Drop all tables in correct order (respecting foreign key constraints)
    await client.query('DROP TABLE IF EXISTS standup_messages CASCADE');
    await client.query('DROP TABLE IF EXISTS standup_entries CASCADE');
    await client.query('DROP TABLE IF EXISTS standups CASCADE');
    await client.query('DROP TABLE IF EXISTS task_logs CASCADE');
    await client.query('DROP TABLE IF EXISTS tasks CASCADE');
    await client.query('DROP TABLE IF EXISTS activity_logs CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    await client.query('DROP TABLE IF EXISTS schema_migrations CASCADE');

    // Drop functions
    await client.query('DROP FUNCTION IF EXISTS update_standups_updated_at() CASCADE');
    await client.query('DROP FUNCTION IF EXISTS update_updated_at() CASCADE');
    await client.query(
      'DROP FUNCTION IF EXISTS validate_tags_length(TEXT[]) CASCADE'
    );
    await client.query(
      'DROP FUNCTION IF EXISTS validate_tags_lowercase(TEXT[]) CASCADE'
    );
    await client.query(
      'DROP FUNCTION IF EXISTS validate_tags_not_empty(TEXT[]) CASCADE'
    );

    logger.info('Database tables dropped');

    // Release client before running migrations
    client.release();
    clientReleased = true;

    // Run migrations to recreate schema (don't end pool, we'll do it in finally)
    await runMigrations({ endPool: false });

    logger.info('Database reset completed successfully');
  } catch (error) {
    logger.error('Database reset failed', { error: error.message });
    throw error;
  } finally {
    // Only release if not already released
    if (client && !clientReleased) {
      try {
        client.release();
      } catch (_releaseError) {
        // Ignore release errors
      }
    }
    await pool.end();
  }
}

if (require.main === module) {
  confirmReset()
    .then(() => reset())
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('Error during reset', { error: error.message });
      process.exit(1);
    });
}

module.exports = reset;
