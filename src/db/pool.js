const { Pool } = require('pg');
const { types } = require('pg');

// Override the default parser for TIMESTAMP (type ID 1114)
// Parse timestamps as ISO strings instead of Date objects to preserve timezone info
types.setTypeParser(1114, (str) => str);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', (client) => {
  // Set timezone to UTC for all connections to ensure consistent timestamp handling
  client.query('SET timezone = "UTC"');
  console.log('✅ Database connected');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
  process.exit(-1);
});

module.exports = pool;
