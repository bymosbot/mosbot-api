require('dotenv').config();
const readline = require('readline');
const pool = require('./pool');
const migrate = require('./migrate');

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
  if (dbHost && dbHost !== 'localhost' && dbHost !== '127.0.0.1' && !dbHost.startsWith('postgres')) {
    return true;
  }
  
  return false;
}

function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
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
  
  console.log('\n⚠️  WARNING: Database Reset');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Database: ${dbName}`);
  console.log(`Host: ${dbHost}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  if (isProd) {
    console.log('\n🚨 PRODUCTION ENVIRONMENT DETECTED 🚨');
    console.log('This will DELETE ALL DATA in the production database!');
    console.log('═══════════════════════════════════════════════════════\n');
    
    // Check for --force flag
    const hasForceFlag = process.argv.includes('--force');
    
    if (!hasForceFlag) {
      console.error('❌ Reset blocked: Production environment detected');
      console.error('   To proceed, you must use: npm run db:reset -- --force');
      console.error('   AND confirm when prompted.\n');
      process.exit(1);
    }
    
    // Double confirmation for production
    const confirm1 = await askConfirmation(
      '⚠️  Type "RESET PRODUCTION" (all caps) to confirm: '
    );
    
    if (confirm1 !== 'reset production') {
      console.log('❌ Reset cancelled - confirmation did not match');
      process.exit(0);
    }
    
    const confirm2 = await askConfirmation(
      '⚠️  Type the database name to confirm: '
    );
    
    if (confirm2 !== dbName.toLowerCase()) {
      console.log('❌ Reset cancelled - database name did not match');
      process.exit(0);
    }
  } else {
    console.log('\n⚠️  This will DELETE ALL DATA in the database!');
    console.log('═══════════════════════════════════════════════════════\n');
    
    const confirm = await askConfirmation('Type "yes" to confirm: ');
    
    if (confirm !== 'yes') {
      console.log('❌ Reset cancelled');
      process.exit(0);
    }
  }
  
  // Final countdown
  console.log('\n🔄 Starting reset in 3 seconds...');
  console.log('   Press Ctrl+C to cancel\n');
  
  await new Promise(resolve => setTimeout(resolve, 3000));
}

async function reset() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Resetting database...');
    
    // Drop all tables in correct order (respecting foreign key constraints)
    await client.query('DROP TABLE IF EXISTS task_logs CASCADE');
    await client.query('DROP TABLE IF EXISTS tasks CASCADE');
    await client.query('DROP TABLE IF EXISTS activity_logs CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    
    // Drop functions
    await client.query('DROP FUNCTION IF EXISTS update_updated_at() CASCADE');
    
    console.log('✅ Database tables dropped');
    
    // Release client before running migrations
    client.release();
    
    // Run migrations to recreate schema
    await migrate();
    
    console.log('✅ Database reset completed successfully');
  } catch (error) {
    console.error('❌ Database reset failed:', error);
    throw error;
  } finally {
    if (!client._ended) {
      client.release();
    }
    await pool.end();
  }
}

if (require.main === module) {
  confirmReset()
    .then(() => reset())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

module.exports = reset;
