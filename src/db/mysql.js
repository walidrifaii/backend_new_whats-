const mysql = require('mysql2/promise');

let pool;

const getPool = () => {
  if (pool) return pool;

  const port = parseInt(process.env.DB_PORT || '3306', 10);
  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: Number.isFinite(port) ? port : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '10', 10),
    queueLimit: 0
  };

  pool = mysql.createPool(config);
  return pool;
};

const query = async (sql, params = []) => {
  const [rows] = await getPool().execute(sql, params);
  return rows;
};

const testConnection = async () => {
  const rows = await query('SELECT 1 AS ok');
  return rows?.[0]?.ok === 1;
};

module.exports = {
  getPool,
  query,
  testConnection
};
