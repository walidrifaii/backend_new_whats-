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
    messageBalance: row.message_balance ?? 0,
    createdAt: row.created_at,
    async comparePassword(password) {
      return bcrypt.compare(password, this.password);
    },
    toJSON() {
      const safe = { ...this };
      delete safe.password;
      delete safe.comparePassword;
      delete safe.toJSON;
      return safe;
    }
  };
};

class UserModel {
  static COLUMNS = 'id, name, email, password, role, is_active, message_balance, created_at';

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

    await query(
      `INSERT INTO users (id, name, email, password, role, is_active, message_balance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [id, name, email, hashedPassword, role, isActive ? 1 : 0, messageBalance]
    );

    return this.findById(id);
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
}

module.exports = UserModel;
