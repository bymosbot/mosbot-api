/**
 * Post-migration script for 001_initial_schema.sql
 *
 * Creates the first owner account from environment variables if no owner exists.
 * Set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD before the first run.
 * The bootstrap is skipped (idempotent) if an owner already exists.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const config = require('../../config');

module.exports = async function postMigration(client, logger) {
  const email = config.bootstrap.ownerEmail;
  const password = config.bootstrap.ownerPassword;

  // Skip if an owner already exists (idempotent)
  const existing = await client.query("SELECT id FROM users WHERE role = 'owner' LIMIT 1");
  if (existing.rows.length > 0) {
    logger.info('Bootstrap skipped: owner account already exists');
    return;
  }

  if (!email || !password) {
    logger.warn(
      'No owner account exists and BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD are not set. ' +
        'Set these env vars and restart to create the first owner, or use POST /api/v1/auth/register ' +
        'followed by a manual role promotion in the database.',
    );
    return;
  }

  if (password.length < 12) {
    throw new Error('BOOTSTRAP_OWNER_PASSWORD must be at least 12 characters');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const name = config.bootstrap.ownerName;

  await client.query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, $3, 'owner', true)
     ON CONFLICT (email) DO UPDATE SET role = 'owner', active = true`,
    [name, email, passwordHash],
  );

  /* eslint-disable no-console -- Intentional: bootstrap outputs confirmation for operator */
  console.log('\n' + '='.repeat(60));
  console.log('OWNER ACCOUNT CREATED');
  console.log('='.repeat(60));
  console.log(`  Email: ${email}`);
  console.log('  Password: (as provided in BOOTSTRAP_OWNER_PASSWORD)');
  console.log('\n  Unset BOOTSTRAP_OWNER_PASSWORD from your environment');
  console.log('  after the first successful login.');
  console.log('='.repeat(60) + '\n');
  /* eslint-enable no-console */

  logger.info('Bootstrap owner account created', { email });

  // Generate random passwords for any agent users that still have PLACEHOLDER hashes
  const placeholders = await client.query(
    "SELECT id, name, email FROM users WHERE password_hash = 'PLACEHOLDER'",
  );

  for (const agent of placeholders.rows) {
    const agentPassword = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    const agentHash = await bcrypt.hash(agentPassword, 10);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [agentHash, agent.id]);
    logger.info('Generated password for agent user', { email: agent.email });
  }
};
