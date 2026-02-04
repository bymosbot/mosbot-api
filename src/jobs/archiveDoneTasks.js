const pool = require('../db/pool');

// Postgres advisory lock ID for archiver job (unique 64-bit integer)
const ARCHIVER_LOCK_ID = 123456789;

/**
 * Archives tasks that have been DONE for more than the specified number of days
 * Uses Postgres advisory lock to ensure only one instance runs at a time
 * @param {number} archiveAfterDays - Number of days a task should be DONE before archiving
 * @returns {Promise<number>} - Number of tasks archived
 */
async function archiveDoneTasks(archiveAfterDays = 7) {
  const client = await pool.connect();
  
  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [ARCHIVER_LOCK_ID]);
    
    if (!lockResult.rows[0].acquired) {
      console.log('⏭️  Archive job already running on another instance, skipping...');
      return 0;
    }
    
    console.log('🔒 Acquired advisory lock for archive job');
    
    // Start transaction for archiving + logging
    await client.query('BEGIN');
    
    try {
      // Optional: Backfill existing DONE tasks with done_at if NULL
      // This handles tasks that were marked DONE before the done_at column was added
      await client.query(`
        UPDATE tasks 
        SET done_at = updated_at 
        WHERE status = 'DONE' AND done_at IS NULL
      `);
      
      // Archive tasks that have been DONE for more than archiveAfterDays
      // Use CTE to capture both old and new values for logging
      // Use parameterized query with make_interval() to prevent SQL injection
      const result = await client.query(`
        WITH archived_tasks AS (
          UPDATE tasks 
          SET status = 'ARCHIVE', archived_at = NOW() 
          WHERE status = 'DONE' 
            AND done_at IS NOT NULL 
            AND done_at <= NOW() - make_interval(days => $1)
          RETURNING id, title, done_at
        )
        SELECT * FROM archived_tasks
      `, [archiveAfterDays]);
      
      const archivedCount = result.rows.length;
      
      if (archivedCount > 0) {
        console.log(`📦 Archived ${archivedCount} task(s):`);
        
        // Insert log entry for each archived task
        for (const task of result.rows) {
          await client.query(`
            INSERT INTO task_logs (task_id, event_type, source, actor_id, old_values, new_values)
            VALUES ($1, $2, $3, NULL, $4, $5)
          `, [
            task.id,
            'ARCHIVED_AUTO',
            'cron',
            JSON.stringify({ status: 'DONE', archived_at: null }),
            JSON.stringify({ status: 'ARCHIVE', archived_at: new Date().toISOString() })
          ]);
          
          console.log(`   - ${task.title} (${task.id})`);
        }
      } else {
        console.log('✅ No tasks to archive');
      }
      
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    }
    
    // Release advisory lock
    await client.query('SELECT pg_advisory_unlock($1)', [ARCHIVER_LOCK_ID]);
    console.log('🔓 Released advisory lock');
    
    return archivedCount;
  } catch (error) {
    console.error('❌ Archive job failed:', error);
    
    // Try to release lock on error
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ARCHIVER_LOCK_ID]);
    } catch (unlockError) {
      console.error('Failed to release advisory lock:', unlockError);
    }
    
    throw error;
  } finally {
    client.release();
  }
}

module.exports = archiveDoneTasks;
