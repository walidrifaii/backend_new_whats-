const bcrypt = require('bcryptjs');
const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const mapRowToUser = (row) => {
  if (!row) return null;

  return {
    _id: row.id,
    name: row.name,
    email: row.email,
    password: row.password,
    apiToken: row.api_token || null,
    apiTokenCreatedAt: row.api_token_created_at || null,
    role: row.role,
    isActive: !!row.is_active,
    authToken: row.api_token || row.auth_token || null,
    messageBalance: row.message_balance ?? 0,
    createdAt: row.created_at,
    async comparePassword(password) {
      return bcrypt.compare(password, this.password);
    },
    toJSON() {
      const safe = { ...this };
      delete safe.password;
<<<<<<< HEAD
      delete safe.authToken;
=======
      delete safe.apiToken;
      delete safe.apiTokenCreatedAt;
>>>>>>> 4301074 ( upload image)
      delete safe.comparePassword;
      delete safe.toJSON;
      return safe;
    }
  };
};

class UserModel {
  static COLUMNS = 'id, name, email, password, role, is_active, auth_token, api_token, api_token_created_at, message_balance, created_at';

  static async ensureAuthTokenColumn() {
    try {
      await query(`ALTER TABLE users ADD COLUMN auth_token TEXT NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
    try {
      await query(`ALTER TABLE users ADD COLUMN api_token TEXT NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
    try {
      await query(`ALTER TABLE users ADD COLUMN api_token_created_at DATETIME NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
  }

  static async findOne(filter = {}) {
    const clauses = [];
    const values = [];

    if (filter.email !== undefined) {
      clauses.push('email = ?');
      values.push(String(filter.email).trim().toLowerCase());
    }
    if (filter._id !== undefined) {
      clauses.push('id = ?');
      values.push(String(filter._id));
    }
    if (filter.isActive !== undefined) {
      clauses.push('is_active = ?');
      values.push(filter.isActive ? 1 : 0);
    }

    if (clauses.length === 0) {
      throw new Error('User.findOne requires at least one filter field');
    }

    const rows = await query(
<<<<<<< HEAD
      `SELECT ${this.COLUMNS} FROM users WHERE ${clauses.join(' AND ')} LIMIT 1`,
=======
      `SELECT id, name, email, password, api_token, api_token_created_at, role, is_active, created_at
       FROM users
       WHERE ${clauses.join(' AND ')}
       LIMIT 1`,
>>>>>>> 4301074 ( upload image)
      values
    );
    return mapRowToUser(rows[0]);
  }

  static async findById(id) {
    const rows = await query(
<<<<<<< HEAD
      `SELECT ${this.COLUMNS} FROM users WHERE id = ? LIMIT 1`,
=======
      `SELECT id, name, email, password, api_token, api_token_created_at, role, is_active, created_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
>>>>>>> 4301074 ( upload image)
      [id]
    );
    return mapRowToUser(rows[0]);
  }

  static async findAll() {
    const rows = await query(
      `SELECT ${this.COLUMNS} FROM users ORDER BY created_at DESC`
    );
    return rows.map(mapRowToUser);
  }

  static async create(data) {
    const id = generateObjectId();
    const name = String(data.name || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(String(data.password || ''), 10);
    const role = data.role === 'admin' ? 'admin' : 'user';
    const isActive = data.isActive === undefined ? true : !!data.isActive;
    const messageBalance = parseInt(data.messageBalance) || 0;

    await query(
<<<<<<< HEAD
      `INSERT INTO users (id, name, email, password, role, is_active, message_balance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [id, name, email, hashedPassword, role, isActive ? 1 : 0, messageBalance]
=======
      `INSERT INTO users (id, name, email, password, api_token, api_token_created_at, role, is_active, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NOW())`,
      [id, name, email, hashedPassword, role, isActive ? 1 : 0]
>>>>>>> 4301074 ( upload image)
    );

    return this.findById(id);
  }

<<<<<<< HEAD
  static async updateBalance(userId, newBalance) {
    await query(
      `UPDATE users SET message_balance = ? WHERE id = ?`,
      [newBalance, userId]
    );
    return this.findById(userId);
  }

  static async decrementBalance(userId, amount = 1) {
    await query(
      `UPDATE users SET message_balance = GREATEST(message_balance - ?, 0) WHERE id = ?`,
      [amount, userId]
    );
    return this.findById(userId);
  }

  static async getBalance(userId) {
    const rows = await query(
      `SELECT message_balance FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    return rows[0]?.message_balance ?? 0;
  }

  static async saveToken(userId, token) {
    await query(
      `UPDATE users
       SET auth_token = ?, api_token = ?, api_token_created_at = NOW()
       WHERE id = ?`,
      [String(token), String(token), String(userId)]
    );
  }

  static async clearToken(userId) {
    await query(
      `UPDATE users
       SET auth_token = NULL, api_token = NULL, api_token_created_at = NULL
       WHERE id = ?`,
      [String(userId)]
    );
=======
  static async updateApiToken(userId, apiToken) {
    await query(
      `UPDATE users
       SET api_token = ?, api_token_created_at = NOW()
       WHERE id = ?
       LIMIT 1`,
      [String(apiToken || ''), String(userId)]
    );
  }

  static async ensureApiTokenColumns() {
    const rows = await query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME IN ('api_token', 'api_token_created_at')`
    );

    const existing = new Set(rows.map((r) => String(r.COLUMN_NAME || '')));

    if (!existing.has('api_token')) {
      await query('ALTER TABLE users ADD COLUMN api_token TEXT NULL');
    }
    if (!existing.has('api_token_created_at')) {
      await query('ALTER TABLE users ADD COLUMN api_token_created_at DATETIME NULL');
    }
>>>>>>> 4301074 ( upload image)
  }
}

module.exports = UserModel;
