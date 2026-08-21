const { query } = require('../db/mysql');
const { normalizeMessageSource } = require('../utils/messageSource');

const mapRow = (row) => {
  if (!row) return null;
  return {
    userId: row.user_id,
    name: row.source,
    enabled: !!row.enabled,
    createdAt: row.created_at
  };
};

class UserSourceModel {
  static async ensureTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS user_sources (
        user_id CHAR(24) NOT NULL,
        source VARCHAR(64) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, source),
        CONSTRAINT fk_user_sources_user
          FOREIGN KEY (user_id) REFERENCES users (id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    try {
      await query(`ALTER TABLE user_sources ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
  }

  static async list(userId) {
    if (!userId) return [];
    const rows = await query(
      `SELECT user_id, source, enabled, created_at
       FROM user_sources
       WHERE user_id = ?
       ORDER BY source ASC`,
      [String(userId)]
    );
    return rows.map(mapRow);
  }

  static async listForUsers(userIds) {
    const ids = [...new Set((userIds || []).map((id) => String(id || '')).filter(Boolean))];
    const map = {};
    ids.forEach((id) => { map[id] = []; });
    if (ids.length === 0) return map;
    const rows = await query(
      `SELECT user_id, source, enabled, created_at
       FROM user_sources
       WHERE user_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY source ASC`,
      ids
    );
    for (const row of rows) {
      const key = String(row.user_id);
      if (!map[key]) map[key] = [];
      map[key].push(mapRow(row));
    }
    return map;
  }

  static async upsert(userId, source, enabled = true) {
    const name = normalizeMessageSource(source);
    if (!name) {
      const err = new Error('Invalid source name');
      err.status = 400;
      throw err;
    }
    await query(
      `INSERT INTO user_sources (user_id, source, enabled, created_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
      [String(userId), name, enabled ? 1 : 0]
    );
    return this.list(userId);
  }

  static async setEnabled(userId, source, enabled) {
    const name = normalizeMessageSource(source);
    if (!name) {
      const err = new Error('Invalid source name');
      err.status = 400;
      throw err;
    }
    await query(
      `UPDATE user_sources SET enabled = ? WHERE user_id = ? AND source = ?`,
      [enabled ? 1 : 0, String(userId), name]
    );
    const list = await this.list(userId);
    if (!list.some((item) => item.name === name)) {
      const err = new Error('Source not found');
      err.status = 404;
      throw err;
    }
    return list;
  }

  static async remove(userId, source) {
    const name = normalizeMessageSource(source);
    if (!name) {
      const err = new Error('Invalid source name');
      err.status = 400;
      throw err;
    }
    await query(
      `DELETE FROM user_sources WHERE user_id = ? AND source = ?`,
      [String(userId), name]
    );
    return this.list(userId);
  }
}

module.exports = UserSourceModel;
