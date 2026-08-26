const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');
const { normalizeMessageSource } = require('../utils/messageSource');
const { APP, CLIENT, OTP_NUMBER } = require('../db/tables');
const { tableExists } = require('../db/alignDiagramSchema');

const mapRow = (row) => {
  if (!row) return null;
  const title = row.number_title || row.title || '';
  const phone = row.number_phone || row.number || '';
  const service = row.service || null;
  const labelParts = [];
  if (service) labelParts.push(service);
  if (title && title.toLowerCase() !== String(service || '').toLowerCase()) labelParts.push(title);
  if (phone) labelParts.push(`+${phone}`);
  if (labelParts.length === 0) labelParts.push('Assignment');
  return {
    _id: row.id,
    clientId: row.client_id || row.user_id,
    otpNumberId: row.OTP_NUMBER_id || row.otp_number_id || row.phone_number_id,
    service,
    isActive: Boolean(row.Active ?? row.active ?? row.is_active),
    balance: Number(row.balance) || 0,
    numberTitle: title || null,
    numberPhone: phone || null,
    numberStatus: row.number_status || row.status || null,
    label: labelParts.join(' · '),
    createdAt: row.created_at
  };
};

/** phone_number_users: client ↔ OTP number ↔ project (service). JS module kept as App. */
class AppModel {
  static async ensureTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS ${APP} (
        id CHAR(24) NOT NULL,
        client_id CHAR(24) NOT NULL,
        OTP_NUMBER_id CHAR(24) NOT NULL,
        service VARCHAR(64) NOT NULL,
        \`Active\` BOOLEAN NOT NULL DEFAULT TRUE,
        balance INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pnu_client_number_service (client_id, OTP_NUMBER_id, service),
        KEY idx_pnu_otp_number_id (OTP_NUMBER_id),
        KEY idx_pnu_client_id (client_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.syncFromSources();
  }

  static async syncFromSources() {
    if (!(await tableExists('user_sources'))) return;
    try {
      const rows = await query(`
        SELECT us.user_id, us.source, us.enabled, us.phone_number_id, u.message_balance
        FROM user_sources us
        INNER JOIN ${CLIENT} u ON u.id = us.user_id
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
    } catch (err) {
      console.warn('App.syncFromSources skipped:', err.message);
    }
  }

  static async findById(id) {
    if (!id) return null;
    const rows = await query(
      `SELECT a.*, pn.title AS number_title, pn.number AS number_phone, pn.status AS number_status
       FROM ${APP} a
       LEFT JOIN ${OTP_NUMBER} pn ON pn.id = a.OTP_NUMBER_id
       WHERE a.id = ? LIMIT 1`,
      [String(id)]
    );
    return mapRow(rows[0]);
  }

  static async listForClient(clientId, { activeOnly = false } = {}) {
    if (!clientId) return [];
    const where = activeOnly
      ? 'a.client_id = ? AND a.`Active` = 1'
      : 'a.client_id = ?';
    const rows = await query(
      `SELECT a.*, pn.title AS number_title, pn.number AS number_phone, pn.status AS number_status
       FROM ${APP} a
       LEFT JOIN ${OTP_NUMBER} pn ON pn.id = a.OTP_NUMBER_id
       WHERE ${where}
       ORDER BY pn.title ASC, a.service ASC`,
      [String(clientId)]
    );
    return rows.map(mapRow);
  }

  static async findByClientService(clientId, service) {
    const name = normalizeMessageSource(service);
    if (!clientId || !name) return null;
    const rows = await query(
      `SELECT * FROM ${APP} WHERE client_id = ? AND service = ? LIMIT 1`,
      [String(clientId), name]
    );
    return mapRow(rows[0]);
  }

  static async findByClientNumber(clientId, otpNumberId, service = 'whatsapp') {
    const name = normalizeMessageSource(service) || 'whatsapp';
    if (!clientId || !otpNumberId) return null;
    const rows = await query(
      `SELECT * FROM ${APP} WHERE client_id = ? AND OTP_NUMBER_id = ? AND service = ? LIMIT 1`,
      [String(clientId), String(otpNumberId), name]
    );
    return mapRow(rows[0]);
  }

  static async assignToClient(clientId, otpNumberId, { service = 'whatsapp', balance, isActive = true } = {}) {
    let credits = balance;
    if (credits === undefined && otpNumberId) {
      try {
        const WhatsAppClientModel = require('./WhatsAppClient');
        const number = await WhatsAppClientModel.findOne({ _id: otpNumberId });
        credits = Number(number?.messageBalance) || 0;
      } catch (_) {
        credits = 0;
      }
    }
    return this.upsert({
      clientId,
      otpNumberId,
      service,
      isActive,
      balance: credits
    });
  }

  /** Keep phone_number_users.balance in sync when admin tops up an OTP number. */
  static async setBalanceForOtpNumber(otpNumberId, balance) {
    if (!otpNumberId) return;
    const value = Math.max(0, parseInt(balance, 10) || 0);
    await query(
      `UPDATE ${APP} SET balance = ? WHERE OTP_NUMBER_id = ?`,
      [value, String(otpNumberId)]
    );
  }

  static async setBalance(appId, balance) {
    if (!appId) return null;
    await query(
      `UPDATE ${APP} SET balance = ? WHERE id = ?`,
      [Math.max(0, parseInt(balance, 10) || 0), String(appId)]
    );
    return this.findById(appId);
  }

  static async deactivateForAssignment(clientId, otpNumberId) {
    if (!otpNumberId) return;
    if (clientId) {
      await query(
        `UPDATE ${APP} SET \`Active\` = 0 WHERE client_id = ? AND OTP_NUMBER_id = ?`,
        [String(clientId), String(otpNumberId)]
      );
      return;
    }
    await query(
      `UPDATE ${APP} SET \`Active\` = 0 WHERE OTP_NUMBER_id = ?`,
      [String(otpNumberId)]
    );
  }

  static async upsert({ clientId, otpNumberId, service, isActive = true, balance } = {}) {
    const name = normalizeMessageSource(service) || 'whatsapp';
    if (!clientId || !otpNumberId) return null;

    const existing = await this.findByClientNumber(clientId, otpNumberId, name);
    if (existing) {
      const sets = ['`Active` = ?'];
      const values = [isActive ? 1 : 0];
      if (balance !== undefined) {
        sets.push('balance = ?');
        values.push(Math.max(0, parseInt(balance, 10) || 0));
      }
      values.push(existing._id);
      await query(`UPDATE ${APP} SET ${sets.join(', ')} WHERE id = ?`, values);
      return this.findById(existing._id);
    }

    const id = generateObjectId();
    await query(
      `INSERT INTO ${APP} (id, OTP_NUMBER_id, client_id, service, \`Active\`, balance, created_at)
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
    await query(`UPDATE ${CLIENT} SET \`current_App_id\` = ? WHERE id = ?`, [
      appId ? String(appId) : null,
      String(clientId)
    ]);
    return this.findById(appId);
  }

  static async decrementBalance(appId, amount = 1) {
    if (!appId) return null;
    await query(
      `UPDATE ${APP} SET balance = GREATEST(balance - ?, 0) WHERE id = ?`,
      [Math.max(1, parseInt(amount, 10) || 1), String(appId)]
    );
    return this.findById(appId);
  }

  static async addBalance(appId, amount = 0) {
    if (!appId) return null;
    await query(
      `UPDATE ${APP} SET balance = balance + ? WHERE id = ?`,
      [Math.max(0, parseInt(amount, 10) || 0), String(appId)]
    );
    return this.findById(appId);
  }
}

module.exports = AppModel;
