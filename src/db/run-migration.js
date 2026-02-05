#!/usr/bin/env node

/**
 * Migration Runner
 * Runs a specific SQL migration file against the database
 */

const fs = require('fs');
const path = require('path');

// Load environment variables first
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = require('./pool');

async function runMigration(migrationFile) {
  const migrationPath = path.join(__dirname, 'migrations', migrationFile);
  
  if (!fs.existsSync(migrationPath)) {
    console.error(`❌ Migration file not found: ${migrationPath}`);
    process.exit(1);
  }
  
  const sql = fs.readFileSync(migrationPath, 'utf8');
  
  console.log(`🔄 Running migration: ${migrationFile}`);
  console.log('─'.repeat(60));
  
  try {
    const result = await pool.query(sql);
    console.log('✅ Migration completed successfully');
    
    if (result && result.rows) {
      console.log(`   Affected rows: ${result.rowCount || 0}`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:');
    console.error(error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

// Get migration file from command line argument
const migrationFile = process.argv[2];

if (!migrationFile) {
  console.error('Usage: node run-migration.js <migration-file>');
  console.error('Example: node run-migration.js 001-add-task-id-to-activity-logs.sql');
  process.exit(1);
}

runMigration(migrationFile);
