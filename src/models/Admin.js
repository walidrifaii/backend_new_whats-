const { query } = require('../db/mysql');
const bcrypt = require('bcryptjs');

class AdminModel {
  static mapRow(row) {
    if (!row) return null;
    return {
      _id: row.id,
      name: row.name || 'Admin',
      email: row.email,
      password: row.password,
      isActive: row.is_active === undefined ? true : !!row.is_active,
      role: 'admin',
      isAdmin: true,
      createdAt: row.created_at
    };
  }

  static async findById(id) {
    const rows = await query(
      `SELECT id, name, email, password, is_active, created_at
       FROM admins
       WHERE id = ?
       LIMIT 1`,
      [String(id)]
    );
    return this.mapRow(rows[0]);
  }

  static async findByEmail(email) {
    const rows = await query(
      `SELECT id, name, email, password, is_active, created_at
       FROM admins
       WHERE email = ?
       LIMIT 1`,
      [String(email).trim().toLowerCase()]
    );
    return this.mapRow(rows[0]);
  }

  static async comparePassword(admin, plainPassword) {
    if (!admin?.password) return false;
    const input = String(plainPassword || '');

    // Normal secure path.
    try {
      const ok = await bcrypt.compare(input, admin.password);
      if (ok) return true;
    } catch (_) {
      // Ignore and fallback below.
    }

    // Backward-compatibility: support legacy plain text admin password rows.
    return admin.password === input;
  }

  static async updatePasswordHash(adminId, plainPassword) {
    const hashedPassword = await bcrypt.hash(String(plainPassword || ''), 10);
    await query(
      `UPDATE admins SET password = ? WHERE id = ?`,
      [hashedPassword, String(adminId)]
    );
    return true;
  }

  static async create({ name, email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(String(password || ''), 10);

    await query(
      `INSERT INTO admins (name, email, password, is_active, created_at)
       VALUES (?, ?, ?, 1, NOW())`,
      [String(name || 'Admin').trim(), normalizedEmail, hashedPassword]
    );
    return this.findByEmail(normalizedEmail);
  }

  static async list() {
    return query(
      `SELECT id, name, email, is_active, created_at
       FROM admins a
       ORDER BY a.created_at DESC`
    );
  }
}

module.exports = AdminModel;

