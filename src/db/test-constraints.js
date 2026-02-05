#!/usr/bin/env node

/**
 * Test Database Constraints
 * Verifies that the database constraints are working correctly
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = require('./pool');

async function testConstraints() {
  console.log('🧪 Testing Database Constraints');
  console.log('═'.repeat(60));
  
  let testsPassed = 0;
  let testsFailed = 0;
  
  try {
    // Get a test user ID
    const userResult = await pool.query('SELECT id FROM users LIMIT 1');
    if (userResult.rows.length === 0) {
      console.error('❌ No users found in database. Cannot run tests.');
      process.exit(1);
    }
    const testUserId = userResult.rows[0].id;
    
    // Test 1: Too many tags (should fail)
    console.log('\n📋 Test 1: Reject task with 21 tags');
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
      console.log('   ❌ FAILED: Should have rejected 21 tags');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: 21 tags rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 2: Tag too long (should fail)
    console.log('\n📋 Test 2: Reject task with tag > 50 characters');
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
      console.log('   ❌ FAILED: Should have rejected long tag');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: Long tag rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 3: Uppercase tags (should fail)
    console.log('\n📋 Test 3: Reject task with uppercase tags');
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
      console.log('   ❌ FAILED: Should have rejected uppercase tags');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: Uppercase tags rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 4: Empty tags (should fail)
    console.log('\n📋 Test 4: Reject task with empty tags');
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
      console.log('   ❌ FAILED: Should have rejected empty tags');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: Empty tags rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 5: Invalid email format (should fail)
    console.log('\n📋 Test 5: Reject user with invalid email');
    try {
      await pool.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)`,
        ['Test User', 'invalid-email', 'dummy-hash', 'user']
      );
      console.log('   ❌ FAILED: Should have rejected invalid email');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: Invalid email rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 6: done_at without DONE status (should fail)
    console.log('\n📋 Test 6: Reject task with done_at but status != DONE');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, done_at)
         VALUES ($1, $2, $3, $4)`,
        ['Test Task - Invalid done_at', 'TO DO', testUserId, new Date()]
      );
      console.log('   ❌ FAILED: Should have rejected done_at on non-DONE task');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: done_at on non-DONE task rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 7: archived_at without ARCHIVE status (should fail)
    console.log('\n📋 Test 7: Reject task with archived_at but status != ARCHIVE');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, archived_at)
         VALUES ($1, $2, $3, $4)`,
        ['Test Task - Invalid archived_at', 'TO DO', testUserId, new Date()]
      );
      console.log('   ❌ FAILED: Should have rejected archived_at on non-ARCHIVE task');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: archived_at on non-ARCHIVE task rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 8: Empty title (should fail)
    console.log('\n📋 Test 8: Reject task with empty title');
    try {
      await pool.query(
        `INSERT INTO tasks (title, status, reporter_id)
         VALUES ($1, $2, $3)`,
        ['   ', 'TO DO', testUserId]
      );
      console.log('   ❌ FAILED: Should have rejected empty title');
      testsFailed++;
    } catch (error) {
      if (error.code === '23514') {
        console.log('   ✅ PASSED: Empty title rejected');
        testsPassed++;
      } else {
        console.log(`   ❌ FAILED: Unexpected error: ${error.message}`);
        testsFailed++;
      }
    }
    
    // Test 9: Valid task with tags (should succeed)
    console.log('\n📋 Test 9: Accept valid task with tags');
    try {
      const result = await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, tags)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['Test Task - Valid Tags', 'TO DO', testUserId, ['tag1', 'tag2', 'tag3']]
      );
      
      // Clean up
      await pool.query('DELETE FROM tasks WHERE id = $1', [result.rows[0].id]);
      
      console.log('   ✅ PASSED: Valid task with tags accepted');
      testsPassed++;
    } catch (error) {
      console.log(`   ❌ FAILED: Should have accepted valid task: ${error.message}`);
      testsFailed++;
    }
    
    // Test 10: Valid task with DONE status and done_at (should succeed)
    console.log('\n📋 Test 10: Accept DONE task with done_at');
    try {
      const result = await pool.query(
        `INSERT INTO tasks (title, status, reporter_id, done_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['Test Task - Valid DONE', 'DONE', testUserId, new Date()]
      );
      
      // Clean up
      await pool.query('DELETE FROM tasks WHERE id = $1', [result.rows[0].id]);
      
      console.log('   ✅ PASSED: DONE task with done_at accepted');
      testsPassed++;
    } catch (error) {
      console.log(`   ❌ FAILED: Should have accepted DONE task: ${error.message}`);
      testsFailed++;
    }
    
    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('📊 Test Results:');
    console.log(`   ✅ Passed: ${testsPassed}`);
    console.log(`   ❌ Failed: ${testsFailed}`);
    console.log(`   Total:  ${testsPassed + testsFailed}`);
    console.log('═'.repeat(60));
    
    if (testsFailed === 0) {
      console.log('\n🎉 All tests passed!');
      process.exit(0);
    } else {
      console.log('\n⚠️  Some tests failed!');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ Test suite error:', error);
    process.exit(1);
  }
}

testConstraints();
