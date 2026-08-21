const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');
const { normalizeMessageSource } = require('../utils/messageSource');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    clientId: row.user_id,
    otpNumberId: row.phone_number_id,
    service: row.service || null,
    isActive: Boolean(row.is_active),
    balance: Number(row.balance) || 0,
    createdAt: row.created_at
  };
};

class AppModel {
  static async ensureTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS apps (
        id CHAR(24) NOT NULL,
        phone_number_id CHAR(24) NOT NULL,
        user_id CHAR(24) NOT NULL,
        service VARCHAR(64) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        balance INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_apps_client_service (user_id, service),
        KEY idx_apps_phone_number_id (phone_number_id),
        KEY idx_apps_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const columns = [
      ['service', 'VARCHAR(64) NULL'],
      ['is_active', 'BOOLEAN NOT NULL DEFAULT TRUE'],
      ['balance', 'INT NOT NULL DEFAULT 0']
    ];
    for (const [name, def] of columns) {
      try {
        await query(`ALTER TABLE apps ADD COLUMN ${name} ${def}`);
      } catch (err) {
        if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
          throw err;
        }
      }
    }

    await query(`UPDATE apps SET service = 'default' WHERE service IS NULL OR service = ''`);

    try {
      await query('CREATE UNIQUE INDEX uq_apps_client_service ON apps (user_id, service)');
    } catch (err) {
      if (!(err.code === 'ER_DUP_KEYNAME' || String(err.message || '').includes('Duplicate key'))) {
        throw err;
      }
    }

    try {
      await query(`ALTER TABLE users ADD COLUMN current_app_id CHAR(24) NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }

    await this.syncFromSources();
  }

  static async syncFromSources() {
    const rows = await query(`
      SELECT us.user_id, us.source, us.enabled, us.phone_number_id, u.message_balance
      FROM user_sources us
      INNER JOIN users u ON u.id = us.user_id
      WHERE us.source IS NOT NULL AND us.source <> ''
    `);
    for (const row of rows) {
      await this.upsert({
        clientId: row.user_id,
        otpNumberId: row.phone_number_id,
        service: row.source,
        isActive: Boolean(row.enabled),
        balance: Number(row.message_balance) || 0
      });
    }
  }

  static async findById(id) {
    if (!id) return null;
    const rows = await query(`SELECT * FROM apps WHERE id = ? LIMIT 1`, [String(id)]);
    return mapRow(rows[0]);
  }

  static async listForClient(clientId, { activeOnly = false } = {}) {
    if (!clientId) return [];
    const sql = activeOnly
      ? `SELECT * FROM apps WHERE user_id = ? AND is_active = 1 ORDER BY service ASC`
      : `SELECT * FROM apps WHERE user_id = ? ORDER BY service ASC`;
    const rows = await query(sql, [String(clientId)]);
    return rows.map(mapRow);
  }

  static async findByClientService(clientId, service) {
    const name = normalizeMessageSource(service);
    if (!clientId || !name) return null;
    const rows = await query(
      `SELECT * FROM apps WHERE user_id = ? AND service = ? LIMIT 1`,
      [String(clientId), name]
    );
    return mapRow(rows[0]);
  }

  static async upsert({ clientId, otpNumberId, service, isActive = true, balance } = {}) {
    const name = normalizeMessageSource(service) || 'default';
    if (!clientId) return null;

    const existing = await this.findByClientService(clientId, name);
    if (existing) {
      const sets = ['is_active = ?'];
      const values = [isActive ? 1 : 0];
      if (otpNumberId) {
        sets.push('phone_number_id = ?');
        values.push(String(otpNumberId));
      }
      if (balance !== undefined) {
        sets.push('balance = ?');
        values.push(Math.max(0, parseInt(balance, 10) || 0));
      }
      values.push(existing._id);
      await query(`UPDATE apps SET ${sets.join(', ')} WHERE id = ?`, values);
      return this.findById(existing._id);
    }

    if (!otpNumberId) return null;
    const id = generateObjectId();
    await query(
      `INSERT INTO apps (id, phone_number_id, user_id, service, is_active, balance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        id,
        String(otpNumberId),
        String(clientId),
        name,
        isActive ? 1 : 0,
        Math.max(0, parseInt(balance, 10) || 0)
      ]
    );
    return this.findById(id);
  }

  static async resolveForSend(clientId, { source = null, currentAppId = null, allowSwitch = false } = {}) {
    const requested = normalizeMessageSource(source);
    if (requested) {
      const app = await this.findByClientService(clientId, requested);
      if (!app || !app.isActive) return null;
      if (!allowSwitch && currentAppId && String(currentAppId) !== String(app._id)) {
        return null;
      }
      return app;
    }
    if (currentAppId) {
      const current = await this.findById(currentAppId);
      if (current && String(current.clientId) === String(clientId) && current.isActive) {
        return current;
      }
    }
    const list = await this.listForClient(clientId, { activeOnly: true });
    return list[0] || null;
  }

  static async setCurrent(clientId, appId) {
    await query(`UPDATE users SET current_app_id = ? WHERE id = ?`, [
      appId ? String(appId) : null,
      String(clientId)
    ]);
    return this.findById(appId);
  }

  static async decrementBalance(appId, amount = 1) {
    if (!appId) return null;
    await query(
      `UPDATE apps SET balance = GREATEST(balance - ?, 0) WHERE id = ?`,
      [Math.max(1, parseInt(amount, 10) || 1), String(appId)]
    );
    return this.findById(appId);
  }

  static async addBalance(appId, amount = 0) {
    if (!appId) return null;
    await query(
      `UPDATE apps SET balance = balance + ? WHERE id = ?`,
      [Math.max(0, parseInt(amount, 10) || 0), String(appId)]
    );
    return this.findById(appId);
  }
}

module.exports = AppModel;
