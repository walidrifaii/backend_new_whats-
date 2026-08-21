const { query } = require('../db/mysql');
const { normalizeMessageSource } = require('../utils/messageSource');

const LIST_SQL = `
  SELECT
    us.user_id, us.source, us.enabled, us.phone_number_id, us.created_at,
    pn.name AS number_name, pn.phone AS number_phone, pn.status AS number_status,
    pn.client_id AS number_client_id
  FROM user_sources us
  LEFT JOIN phone_numbers pn ON pn.id = us.phone_number_id
`;

const mapRow = (row) => {
  if (!row) return null;
  const phoneNumberId = row.phone_number_id || null;
  return {
    userId: row.user_id,
    name: row.source,
    enabled: !!row.enabled,
    phoneNumberId,
    phoneNumber: phoneNumberId
      ? {
          _id: phoneNumberId,
          name: row.number_name || '',
          phone: row.number_phone || null,
          status: row.number_status || '',
          clientId: row.number_client_id || null
        }
      : null,
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
        phone_number_id CHAR(24) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, source),
        KEY idx_user_sources_phone_number_id (phone_number_id),
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
    try {
      await query(`ALTER TABLE user_sources ADD COLUMN phone_number_id CHAR(24) NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
    try {
      await query(`ALTER TABLE user_sources ADD INDEX idx_user_sources_phone_number_id (phone_number_id)`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_KEYNAME' || String(err.message || '').includes('Duplicate key'))) {
        throw err;
      }
    }
  }

  static async list(userId) {
    if (!userId) return [];
    const rows = await query(
      `${LIST_SQL} WHERE us.user_id = ? ORDER BY us.source ASC`,
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
      `${LIST_SQL} WHERE us.user_id IN (${ids.map(() => '?').join(', ')}) ORDER BY us.source ASC`,
      ids
    );
    for (const row of rows) {
      const key = String(row.user_id);
      if (!map[key]) map[key] = [];
      map[key].push(mapRow(row));
    }
    return map;
  }

  static async upsert(userId, source, { enabled = true, phoneNumberId } = {}) {
    const name = normalizeMessageSource(source);
    if (!name) {
      const err = new Error('Invalid service name');
      err.status = 400;
      throw err;
    }
    const numberId = phoneNumberId ? String(phoneNumberId) : null;
    await query(
      `INSERT INTO user_sources (user_id, source, enabled, phone_number_id, created_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         enabled = VALUES(enabled),
         phone_number_id = COALESCE(VALUES(phone_number_id), phone_number_id)`,
      [String(userId), name, enabled ? 1 : 0, numberId]
    );
    return this.list(userId);
  }

  static async setEnabled(userId, source, enabled) {
    const name = normalizeMessageSource(source);
    if (!name) {
      const err = new Error('Invalid service name');
      err.status = 400;
      throw err;
    }
    await query(
      `UPDATE user_sources SET enabled = ? WHERE user_id = ? AND source = ?`,
      [enabled ? 1 : 0, String(userId), name]
    );
    const list = await this.list(userId);
    if (!list.some((item) => item.name === name)) {
      const err = new Error('Service not found');
      err.status = 404;
      throw err;
    }
    return list;
  }

  static async setPhoneNumber(userId, source, phoneNumberId) {
    const name = normalizeMessageSource(source);
    if (!name) {
      const err = new Error('Invalid service name');
      err.status = 400;
      throw err;
    }
    const numberId = phoneNumberId ? String(phoneNumberId) : null;
    await query(
      `UPDATE user_sources SET phone_number_id = ? WHERE user_id = ? AND source = ?`,
      [numberId, String(userId), name]
    );
    const list = await this.list(userId);
    if (!list.some((item) => item.name === name)) {
      const err = new Error('Service not found');
      err.status = 404;
      throw err;
    }
    return list;
  }

  static async remove(userId, source) {
    const name = normalizeMessageSource(source);
    if (!name) {
      const err = new Error('Invalid service name');
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
