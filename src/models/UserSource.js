const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');
const { normalizeMessageSource } = require('../utils/messageSource');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.user_id,
    source: row.source,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at
  };
};

class UserSourceModel {
  static async ensureTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS user_sources (
        id CHAR(24) NOT NULL PRIMARY KEY,
        user_id CHAR(24) NOT NULL,
        source VARCHAR(64) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_sources_user_source (user_id, source),
        KEY idx_user_sources_user_id (user_id)
      )
    `);
  }

  static async listByUser(userId) {
    const rows = await query(
      `SELECT * FROM user_sources WHERE user_id = ? ORDER BY source ASC`,
      [String(userId)]
    );
    return rows.map(mapRow);
  }

  static async findOne(userId, source) {
    const sourceName = normalizeMessageSource(source);
    if (!sourceName) return null;
    const rows = await query(
      `SELECT * FROM user_sources WHERE user_id = ? AND source = ? LIMIT 1`,
      [String(userId), sourceName]
    );
    return mapRow(rows[0]);
  }

  static async upsert({ userId, source, enabled }) {
    const sourceName = normalizeMessageSource(source);
    if (!sourceName) {
      const err = new Error('Invalid source name');
      err.status = 400;
      throw err;
    }
    const existing = await this.findOne(userId, sourceName);
    if (existing) {
      await query(
        `UPDATE user_sources SET enabled = ? WHERE id = ?`,
        [enabled ? 1 : 0, existing._id]
      );
      return this.findOne(userId, sourceName);
    }
    const id = generateObjectId();
    await query(
      `INSERT INTO user_sources (id, user_id, source, enabled) VALUES (?, ?, ?, ?)`,
      [id, String(userId), sourceName, enabled ? 1 : 0]
    );
    return this.findOne(userId, sourceName);
  }

  static async setEnabledSources(userId, sources = []) {
    const wanted = [...new Set(
      (Array.isArray(sources) ? sources : [])
        .map((item) => normalizeMessageSource(item))
        .filter(Boolean)
    )];
    const existing = await this.listByUser(userId);
    const wantedSet = new Set(wanted);

    for (const row of existing) {
      await query(
        `UPDATE user_sources SET enabled = ? WHERE id = ?`,
        [wantedSet.has(row.source) ? 1 : 0, row._id]
      );
    }
    for (const source of wanted) {
      if (!existing.some((row) => row.source === source)) {
        await this.upsert({ userId, source, enabled: true });
      }
    }
    return this.listByUser(userId);
  }

  static async remove(userId, sources = []) {
    const names = [...new Set(
      (Array.isArray(sources) ? sources : [sources])
        .map((item) => normalizeMessageSource(item))
        .filter(Boolean)
    )];
    if (!names.length) return 0;
    const placeholders = names.map(() => '?').join(', ');
    const result = await query(
      `DELETE FROM user_sources WHERE user_id = ? AND source IN (${placeholders})`,
      [String(userId), ...names]
    );
    return result?.affectedRows || 0;
  }

  static async listKnownNames(ownerId) {
    const id = String(ownerId);
    const names = new Set();
    const rows = await this.listByUser(id);
    for (const row of rows) {
      if (row.source) names.add(row.source);
    }
    const childRows = await query(
      `SELECT DISTINCT source FROM users WHERE parent_user_id = ? AND source IS NOT NULL AND source <> ''`,
      [id]
    );
    for (const row of childRows) {
      const name = normalizeMessageSource(row.source);
      if (name) names.add(name);
    }
    const logRows = await query(
      `SELECT DISTINCT source FROM message_logs WHERE user_id = ? AND source IS NOT NULL AND source <> ''`,
      [id]
    );
    for (const row of logRows) {
      const name = normalizeMessageSource(row.source);
      if (name) names.add(name);
    }
    return [...names].sort();
  }

  static async countEnabled(userId) {
    const rows = await query(
      `SELECT COUNT(*) AS total FROM user_sources WHERE user_id = ? AND enabled = 1`,
      [String(userId)]
    );
    return Number(rows[0]?.total) || 0;
  }
}

module.exports = UserSourceModel;
