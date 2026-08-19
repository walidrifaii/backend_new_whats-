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
    role: row.role,
    isActive: !!row.is_active,
    authToken: row.api_token || row.auth_token || null,
    messageBalance: row.message_balance ?? 0,
    parentUserId: row.parent_user_id || null,
    source: row.source || null,
    isServiceAccount: Boolean(row.parent_user_id),
    createdAt: row.created_at,
    async comparePassword(password) {
      return bcrypt.compare(password, this.password);
    },
    toJSON() {
      const safe = { ...this };
      delete safe.password;
      delete safe.authToken;
      delete safe.comparePassword;
      delete safe.toJSON;
      return safe;
    }
  };
};

class UserModel {
  static COLUMNS = 'id, name, email, password, role, is_active, auth_token, api_token, api_token_created_at, message_balance, parent_user_id, source, created_at';

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
    await this.ensureServiceAccountColumns();
  }

  static async ensureServiceAccountColumns() {
    try {
      await query(`ALTER TABLE users ADD COLUMN parent_user_id CHAR(24) NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
    try {
      await query(`ALTER TABLE users ADD COLUMN source VARCHAR(64) NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
    try {
      await query(`ALTER TABLE users ADD INDEX idx_users_parent_user_id (parent_user_id)`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_KEYNAME' || String(err.message || '').includes('Duplicate key'))) {
        throw err;
      }
    }
    try {
      await query(`ALTER TABLE users ADD UNIQUE INDEX uq_users_parent_source (parent_user_id, source)`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_KEYNAME' || String(err.message || '').includes('Duplicate key'))) {
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
    if (filter.parentUserId !== undefined) {
      clauses.push('parent_user_id = ?');
      values.push(String(filter.parentUserId));
    }
    if (filter.source !== undefined) {
      clauses.push('source = ?');
      values.push(String(filter.source));
    }

    if (clauses.length === 0) {
      throw new Error('User.findOne requires at least one filter field');
    }

    const rows = await query(
      `SELECT ${this.COLUMNS} FROM users WHERE ${clauses.join(' AND ')} LIMIT 1`,
      values
    );
    return mapRowToUser(rows[0]);
  }

  static async findById(id) {
    const rows = await query(
      `SELECT ${this.COLUMNS} FROM users WHERE id = ? LIMIT 1`,
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
    const parentUserId = data.parentUserId ? String(data.parentUserId) : null;
    const source = data.source ? String(data.source) : null;

    await query(
      `INSERT INTO users (id, name, email, password, role, is_active, message_balance, parent_user_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [id, name, email, hashedPassword, role, isActive ? 1 : 0, messageBalance, parentUserId, source]
    );

    return this.findById(id);
  }

  static async findByParentUserId(parentUserId) {
    const rows = await query(
      `SELECT ${this.COLUMNS} FROM users WHERE parent_user_id = ? ORDER BY created_at DESC`,
      [String(parentUserId)]
    );
    return rows.map(mapRowToUser);
  }

  static async createServiceAccount({ parent, name, email, password, source, messageBalance }) {
    if (!parent || parent.parentUserId) {
      const err = new Error('Use the WhatsApp owner account to add a service login');
      err.status = 400;
      throw err;
    }

    const { normalizeMessageSource } = require('../utils/messageSource');
    const sourceName = normalizeMessageSource(source);
    if (!sourceName) {
      const err = new Error('Source must be letters, numbers, dot, dash, or underscore (example: solv)');
      err.status = 400;
      throw err;
    }

    const cleanEmail = String(email || '').trim().toLowerCase();
    const existingEmail = await this.findOne({ email: cleanEmail });
    if (existingEmail) {
      const err = new Error('Email already registered');
      err.status = 400;
      throw err;
    }

    const existingSource = await this.findOne({ parentUserId: parent._id, source: sourceName });
    if (existingSource) {
      const err = new Error(`This account already has a login for source "${sourceName}"`);
      err.status = 400;
      throw err;
    }

    return this.create({
      name,
      email: cleanEmail,
      password,
      parentUserId: parent._id,
      source: sourceName,
      messageBalance: parseInt(messageBalance, 10) || 0
    });
  }

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
  }
}

module.exports = UserModel;
