require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME IN ('api_token', 'api_token_created_at')`
  );

  const existing = new Set(rows.map((r) => String(r.COLUMN_NAME)));

  if (!existing.has('api_token')) {
    await pool.execute('ALTER TABLE users ADD COLUMN api_token TEXT NULL');
    console.log('Added column: api_token');
  } else {
    console.log('Column already exists: api_token');
  }

  if (!existing.has('api_token_created_at')) {
    await pool.execute('ALTER TABLE users ADD COLUMN api_token_created_at DATETIME NULL');
    console.log('Added column: api_token_created_at');
  } else {
    console.log('Column already exists: api_token_created_at');
  }

  const [verify] = await pool.execute(
    `SELECT COLUMN_NAME, DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME IN ('api_token', 'api_token_created_at')
     ORDER BY COLUMN_NAME`
  );

  console.log('Verified columns:', verify);
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
