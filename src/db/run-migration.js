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
const logger = require('../utils/logger');

async function runMigration(migrationFile) {
  const migrationPath = path.join(__dirname, 'migrations', migrationFile);
  
  if (!fs.existsSync(migrationPath)) {
    logger.error('Migration file not found', { path: migrationPath });
    process.exit(1);
  }
  
  const sql = fs.readFileSync(migrationPath, 'utf8');
  
  logger.info(`Running migration: ${migrationFile}`);
  
  try {
    const result = await pool.query(sql);
    logger.info('Migration completed successfully', {
      affectedRows: result?.rowCount || 0
    });
    
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed', {
      error: error.message,
      fullError: error
    });
    process.exit(1);
  }
}

// Get migration file from command line argument
const migrationFile = process.argv[2];

if (!migrationFile) {
  logger.error('Usage: node run-migration.js <migration-file>', {
    example: 'node run-migration.js 001-add-task-id-to-activity-logs.sql'
  });
  process.exit(1);
}

runMigration(migrationFile);
