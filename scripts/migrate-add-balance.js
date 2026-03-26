/**
 * Migration: Add message_balance column to users table
 * and create a default admin user if none exists.
 *
 * Usage: node scripts/migrate-add-balance.js
 */
require('dotenv').config();
const { query, testConnection } = require('../src/db/mysql');
const bcrypt = require('bcryptjs');
const { generateObjectId } = require('../src/utils/objectId');

async function migrate() {
  const ok = await testConnection();
  if (!ok) {
    console.error('Cannot connect to MySQL');
    process.exit(1);
  }
  console.log('Connected to MySQL');

  // Create admins table if it doesn't exist (standalone login table)
  await query(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL DEFAULT 'Admin',
      email VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_admin_email (email)
    )
  `);
  console.log('Ensured admins table exists');

  // Backfill admins table structure when it was created earlier with old schema.
  try {
    await query(`ALTER TABLE admins DROP FOREIGN KEY fk_admins_user`);
  } catch (err) {
    if (!(err.code === 'ER_CANT_DROP_FIELD_OR_KEY' || err.message.includes("Can't DROP"))) throw err;
  }
  try {
    await query(`ALTER TABLE admins DROP INDEX uniq_admin_user`);
  } catch (err) {
    if (!(err.code === 'ER_CANT_DROP_FIELD_OR_KEY' || err.message.includes("check that column/key exists"))) throw err;
  }
  try {
    await query(`ALTER TABLE admins DROP COLUMN user_id`);
  } catch (err) {
    if (!(err.code === 'ER_CANT_DROP_FIELD_OR_KEY' || err.message.includes('Unknown column'))) throw err;
  }
  try {
    await query(`ALTER TABLE admins ADD COLUMN name VARCHAR(120) NOT NULL DEFAULT 'Admin'`);
  } catch (err) {
    if (!(err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column'))) throw err;
  }
  try {
    await query(`ALTER TABLE admins ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1`);
  } catch (err) {
    if (!(err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column'))) throw err;
  }
  try {
    await query(`ALTER TABLE admins ADD COLUMN password VARCHAR(255) NOT NULL`);
  } catch (err) {
    if (!(err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column'))) throw err;
  }
  try {
    await query(`ALTER TABLE admins ADD UNIQUE KEY uniq_admin_email (email)`);
  } catch (err) {
    if (!(err.code === 'ER_DUP_KEYNAME' || err.message.includes('Duplicate key name'))) throw err;
  }

  // Add message_balance column if it doesn't exist
  try {
    await query(`ALTER TABLE users ADD COLUMN message_balance INT NOT NULL DEFAULT 0`);
    console.log('Added message_balance column to users table');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column')) {
      console.log('message_balance column already exists');
    } else {
      throw err;
    }
  }

  // Create default admin in users table if needed
  const existingRoleAdmins = await query(`SELECT email, password FROM users WHERE role = 'admin' LIMIT 1`);
  if (existingRoleAdmins.length === 0) {
    const userId = generateObjectId();
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await query(
      `INSERT INTO users (id, name, email, password, role, is_active, message_balance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [userId, 'Admin', 'admin@admin.com', hashedPassword, 'admin', 1, 999999]
    );
    await query(
      `INSERT INTO admins (name, email, password, is_active, created_at)
       VALUES (?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE password = VALUES(password), is_active = 1`,
      ['Admin', 'admin@admin.com', hashedPassword]
    );
    console.log('Created default admin user:');
    console.log('  Email: admin@admin.com');
    console.log('  Password: admin123');
    console.log('  (Change this password after first login!)');
  } else {
    const row = existingRoleAdmins[0];
    await query(
      `INSERT INTO admins (name, email, password, is_active, created_at)
       VALUES (?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE password = VALUES(password), is_active = 1`,
      ['Admin', row.email, row.password]
    );
    console.log('Admin user already exists (synced to admins table by email/password)');
  }

  console.log('\nMigration complete!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
