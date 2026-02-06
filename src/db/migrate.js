require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate(options = {}) {
  const { endPool = true } = options;
  const client = await pool.connect();

  try {
    const schemaExistsResult = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1`
    );
    const schemaAlreadyPresent = schemaExistsResult.rows.length > 0;

    if (schemaAlreadyPresent) {
      console.log('🔄 Schema already present, applying idempotent migration...');
    } else {
      console.log('🔄 Applying initial schema...');
    }

    const schemaSQL = fs.readFileSync(
      path.join(__dirname, 'schema.sql'),
      'utf-8'
    );

    await client.query(schemaSQL);

    console.log('✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    if (endPool) {
      await pool.end();
    }
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = migrate;
