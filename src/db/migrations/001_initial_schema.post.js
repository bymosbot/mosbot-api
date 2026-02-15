/**
 * Post-migration script for 001_initial_schema.sql
 * Generates random passwords for agent users and logs them to console
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');

module.exports = async function postMigration(client, logger) {
  logger.info('Running post-migration: Generating random passwords for agent users');

  const agents = [
    { name: 'MosBot', email: 'coo@mosbot.local', role: 'COO' },
    { name: 'Elon', email: 'cto@mosbot.local', role: 'CTO' },
    { name: 'Gary', email: 'cmo@mosbot.local', role: 'CMO' },
    { name: 'Alex', email: 'cpo@mosbot.local', role: 'CPO' }
  ];

  const credentials = [];

  for (const agent of agents) {
    // Generate a secure random password (22 characters, base64)
    const password = crypto.randomBytes(16).toString('base64').slice(0, 22);
    
    // Hash the password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Update the user with the real password hash
    await client.query(
      'UPDATE users SET password_hash = $1 WHERE email = $2 AND password_hash = \'PLACEHOLDER\'',
      [passwordHash, agent.email]
    );
    
    credentials.push({
      role: agent.role,
      name: agent.name,
      email: agent.email,
      password
    });
  }

  // Log credentials to console (only visible during migration)
  /* eslint-disable no-console -- Intentional: migration outputs credentials for operator to save */
  console.log('\n' + '='.repeat(80));
  console.log('AGENT USER CREDENTIALS (Save these securely!)');
  console.log('='.repeat(80));
  console.log('\nCEO (Owner):');
  console.log('  Email:    ceo@mosbot.local');
  console.log('  Password: admin123');
  console.log('  ⚠️  CHANGE THIS PASSWORD AFTER FIRST LOGIN!\n');
  
  credentials.forEach(cred => {
    console.log(`${cred.role} (${cred.name}):`);
    console.log(`  Email:    ${cred.email}`);
    console.log(`  Password: ${cred.password}\n`);
  });
  
  console.log('='.repeat(80) + '\n');
  /* eslint-enable no-console */

  logger.info('Agent passwords generated and set successfully', {
    agentsUpdated: credentials.length
  });
};
