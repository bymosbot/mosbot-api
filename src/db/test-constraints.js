#!/usr/bin/env node

/**
 * Test Database Constraints
 * Verifies that the database constraints are working correctly
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = require('./pool');
const logger = require('../utils/logger');

async function testConstraints() {
  logger.info('Testing Database Constraints');
  
  let testsPassed = 0;
  let testsFailed = 0;
  
  try {
    // Get a test user ID
    const userResult = await pool.query('SELECT id FROM users LIMIT 1');
    if (userResult.rows.length === 0) {
      logger.error('No users found in database. Cannot run tests.');
      process.exit(1);
    }
    const testUserId = userResult.rows[0].id;
    
    // Test 1: Too many tags (should fail)
    logger.info('Test 1: Reject task with 21 tags');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, tags)
         VALUES ($1, $2, $3, $4)`,
        [
          'Test Task - Too Many Tags',
          'TO DO',
          testUserId,
          Array.from({ length: 21 }, (_, i) => `tag${i + 1}`)
        ]
      );
      logger.warn('FAILED: Should have rejected 21 tags');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: 21 tags rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 2: Tag too long (should fail)
    logger.info('Test 2: Reject task with tag > 50 characters');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, tags)
         VALUES ($1, $2, $3, $4)`,
        [
          'Test Task - Long Tag',
          'TO DO',
          testUserId,
          ['this-is-a-very-long-tag-that-exceeds-the-fifty-character-limit-for-tags']
        ]
      );
      logger.warn('FAILED: Should have rejected long tag');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: Long tag rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 3: Uppercase tags (should fail)
    logger.info('Test 3: Reject task with uppercase tags');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, tags)
         VALUES ($1, $2, $3, $4)`,
        [
          'Test Task - Uppercase Tags',
          'TO DO',
          testUserId,
          ['UpperCase', 'MixedCase']
        ]
      );
      logger.warn('FAILED: Should have rejected uppercase tags');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: Uppercase tags rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 4: Empty tags (should fail)
    logger.info('Test 4: Reject task with empty tags');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, tags)
         VALUES ($1, $2, $3, $4)`,
        [
          'Test Task - Empty Tags',
          'TO DO',
          testUserId,
          ['valid-tag', '   ', 'another-tag']
        ]
      );
      logger.warn('FAILED: Should have rejected empty tags');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: Empty tags rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 5: Invalid email format (should fail)
    logger.info('Test 5: Reject user with invalid email');
    try {
      await pool.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)`,
        ['Test User', 'invalid-email', 'dummy-hash', 'user']
      );
      logger.warn('FAILED: Should have rejected invalid email');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: Invalid email rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 6: done_at without DONE status (should fail)
    logger.info('Test 6: Reject task with done_at but status != DONE');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, done_at)
         VALUES ($1, $2, $3, $4)`,
        ['Test Task - Invalid done_at', 'TO DO', testUserId, new Date()]
      );
      logger.warn('FAILED: Should have rejected done_at on non-DONE task');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: done_at on non-DONE task rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 7: archived_at without ARCHIVE status (should fail)
    logger.info('Test 7: Reject task with archived_at but status != ARCHIVE');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, archived_at)
         VALUES ($1, $2, $3, $4)`,
        ['Test Task - Invalid archived_at', 'TO DO', testUserId, new Date()]
      );
      logger.warn('FAILED: Should have rejected archived_at on non-ARCHIVE task');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: archived_at on non-ARCHIVE task rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 8: Empty title (should fail)
    logger.info('Test 8: Reject task with empty title');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id)
         VALUES ($1, $2, $3)`,
        ['   ', 'TO DO', testUserId]
      );
      logger.warn('FAILED: Should have rejected empty title');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        logger.info('PASSED: Empty title rejected');
        testsPassed++;
      } else {
        logger.warn(`FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 9: Valid task with tags (should succeed)
    logger.info('Test 9: Accept valid task with tags');
    try {
      const result = await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, tags)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['Test Task - Valid Tags', 'TO DO', testUserId, ['tag1', 'tag2', 'tag3']]
      );
      
      // Clean up
      await pool.query('DELETE FROM tasks WHERE id = $1', [result.rows[0].id]);
      
      logger.info('PASSED: Valid task with tags accepted');
      testsPassed++;
    } catch (error) {
      logger.warn(`FAILED: Should have accepted valid task: ${error.message}`);
      testsFailed++;
    }
    
    // Test 10: Valid task with DONE status and done_at (should succeed)
    logger.info('Test 10: Accept DONE task with done_at');
    try {
      const result = await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, done_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['Test Task - Valid DONE', 'DONE', testUserId, new Date()]
      );
      
      // Clean up
      await pool.query('DELETE FROM tasks WHERE id = $1', [result.rows[0].id]);
      
      logger.info('PASSED: DONE task with done_at accepted');
      testsPassed++;
    } catch (error) {
      logger.warn(`FAILED: Should have accepted DONE task: ${error.message}`);
      testsFailed++;
    }
    
    // Summary
    logger.info('Test Results', {
      passed: testsPassed,
      failed: testsFailed,
      total: testsPassed + testsFailed
    });
    
    if (testsFailed === 0) {
      logger.info('All tests passed!');
      process.exit(0);
    } else {
      logger.warn('Some tests failed!');
      process.exit(1);
    }
    
  } catch (error) {
    logger.error('Test suite error', { error: error.message });
    process.exit(1);
  }
}

testConstraints();
