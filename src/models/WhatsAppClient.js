const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');
const { OTP_NUMBER, APP, CLIENT } = require('../db/tables');
const { tableExists } = require('../db/alignDiagramSchema');

const SELECT_COLUMNS = `
  pn.id, pn.title AS name, pn.number AS phone, pn.session_id AS client_id, pn.status, pn.qr_code, pn.session_path,
  pn.last_connected, pn.messages_sent, pn.is_active, pn.plan_id, pn.plan_status,
  pn.message_balance, pn.created_at, pn.updated_at
`;

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    name: row.name,
    phone: row.phone,
    clientId: row.client_id,
    status: row.status,
    qrCode: row.qr_code,
    sessionPath: row.session_path,
    lastConnected: row.last_connected,
    messagesSent: row.messages_sent,
    isActive: !!row.is_active,
    planId: row.plan_id || null,
    planStatus: row.plan_status || 'none',
    messageBalance: row.message_balance ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

const ignoreDup = (err) => {
  const code = err?.code || '';
  const message = String(err?.message || '');
  return (
    code === 'ER_DUP_FIELDNAME' ||
    code === 'ER_DUP_KEYNAME' ||
    code === 'ER_FK_DUP_NAME' ||
    message.includes('Duplicate column') ||
    message.includes('Duplicate key') ||
    message.includes('Duplicate foreign key')
  );
};

const ignoreMissing = (err) => {
  const code = err?.code || '';
  const message = String(err?.message || '');
  return (
    code === 'ER_BAD_FIELD_ERROR' ||
    code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
    code === 'ER_CANT_DROP_INDEX' ||
    message.includes("Can't DROP") ||
    message.includes('check that column/key exists')
  );
};

const buildFilter = (filter = {}) => {
  const clauses = [];
  const values = [];

  if (filter._id !== undefined) {
    clauses.push('pn.id = ?');
    values.push(String(filter._id));
  }
  if (filter.isActive !== undefined) {
    clauses.push('pn.is_active = ?');
    values.push(filter.isActive ? 1 : 0);
  }
  if (filter.clientId !== undefined) {
    clauses.push('pn.session_id = ?');
    values.push(String(filter.clientId));
  }
  if (filter.phone !== undefined) {
    clauses.push('pn.number = ?');
    values.push(String(filter.phone));
  }
  if (filter.planId !== undefined) {
    clauses.push('pn.plan_id = ?');
    values.push(String(filter.planId));
  }
  if (filter.status !== undefined) {
    if (filter.status !== null && typeof filter.status === 'object' && Array.isArray(filter.status.$in)) {
      const placeholders = filter.status.$in.map(() => '?').join(', ');
      clauses.push(`pn.status IN (${placeholders})`);
      filter.status.$in.forEach((s) => values.push(String(s)));
    } else {
      clauses.push('pn.status = ?');
      values.push(String(filter.status));
    }
  }

  return { clauses, values };
};

const buildUpdate = (update = {}) => {
  const set = [];
  const values = [];

  const map = {
    name: 'title',
    phone: 'number',
    clientId: 'session_id',
    status: 'status',
    qrCode: 'qr_code',
    sessionPath: 'session_path',
    lastConnected: 'last_connected',
    messagesSent: 'messages_sent',
    isActive: 'is_active',
    planId: 'plan_id',
    planStatus: 'plan_status',
    messageBalance: 'message_balance'
  };

  Object.entries(update).forEach(([key, value]) => {
    if (key === '$inc' || value === undefined) return;
    const column = map[key];
    if (!column) return;
    set.push(`${column} = ?`);
    if (key === 'isActive') values.push(value ? 1 : 0);
    else if (key === 'planId') values.push(value || null);
    else values.push(value);
  });

  if (update.$inc && typeof update.$inc === 'object') {
    Object.entries(update.$inc).forEach(([key, value]) => {
      const column = map[key];
      if (!column) return;
      set.push(`${column} = ${column} + ?`);
      values.push(Number(value) || 0);
    });
  }

  return { set, values };
};

class WhatsAppClientModel {
  static async tableExists(name) {
    return tableExists(name);
  }

  static async columnExists(table, column) {
    const rows = await query(
      `SELECT 1 AS ok
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND LOWER(TABLE_NAME) = LOWER(?)
         AND LOWER(COLUMN_NAME) = LOWER(?)
       LIMIT 1`,
      [String(table).replace(/`/g, ''), column]
    );
    return rows.length > 0;
  }

  static async ensureTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS ${OTP_NUMBER} (
        id CHAR(24) NOT NULL,
        title VARCHAR(120) NOT NULL,
        number VARCHAR(190) NULL,
        session_id VARCHAR(190) NOT NULL,
        status ENUM('disconnected', 'initializing', 'qr_ready', 'connected', 'auth_failure')
          NOT NULL DEFAULT 'disconnected',
        qr_code LONGTEXT NULL,
        session_path VARCHAR(500) NULL,
        last_connected DATETIME NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        messages_sent INT NOT NULL DEFAULT 0,
        plan_id CHAR(24) NULL,
        plan_status VARCHAR(16) NOT NULL DEFAULT 'none',
        message_balance INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_otp_number_session_id (session_id),
        KEY idx_otp_number_plan_id (plan_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  static async ensurePoolColumns() {
    await this.ensureTable();

    const columns = [
      ['session_id', 'VARCHAR(190) NULL'],
      ['title', "VARCHAR(120) NOT NULL DEFAULT ''"],
      ['number', 'VARCHAR(190) NULL'],
      ['plan_id', 'CHAR(24) NULL'],
      ['plan_status', "VARCHAR(16) NOT NULL DEFAULT 'none'"],
      ['message_balance', 'INT NOT NULL DEFAULT 0'],
      ['messages_sent', 'INT NOT NULL DEFAULT 0'],
      ['updated_at', 'DATETIME NULL']
    ];
    for (const [name, def] of columns) {
      try {
        await query(`ALTER TABLE ${OTP_NUMBER} ADD COLUMN ${name} ${def}`);
      } catch (err) {
        if (!ignoreDup(err)) throw err;
      }
    }
  }

  static assignmentJoin(filter = {}) {
    if (filter.userId === null) {
      return {
        join: `LEFT JOIN ${APP} a ON a.OTP_NUMBER_id = pn.id AND a.\`Active\` = 1`,
        clause: 'a.client_id IS NULL',
        values: []
      };
    }
    if (filter.userId !== undefined) {
      return {
        join: `INNER JOIN ${APP} a ON a.OTP_NUMBER_id = pn.id AND a.client_id = ? AND a.\`Active\` = 1`,
        clause: null,
        values: [String(filter.userId)]
      };
    }
    return { join: '', clause: null, values: [] };
  }

  static async find(filter = {}, options = {}) {
    const { clauses, values } = buildFilter(filter);
    const assignment = this.assignmentJoin(filter);
    let sql = `SELECT DISTINCT ${SELECT_COLUMNS} FROM ${OTP_NUMBER} pn ${assignment.join}`;
    const where = [...clauses];
    if (assignment.clause) where.push(assignment.clause);
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;

    if (options.sort?.createdAt === 1) sql += ' ORDER BY pn.created_at ASC';
    else sql += ' ORDER BY pn.created_at DESC';

    if (options.limit !== undefined && options.limit !== null) {
      const limit = Number(options.limit);
      if (Number.isFinite(limit) && limit > 0) {
        sql += ` LIMIT ${Math.floor(limit)}`;
      }
    }

    const rows = await query(sql, [...assignment.values, ...values]);
    return rows.map(mapRow);
  }

  static async findOne(filter = {}) {
    const rows = await this.find(filter, { limit: 1, sort: { createdAt: -1 } });
    return rows[0] || null;
  }

  static async create(data) {
    const id = generateObjectId();

    await query(
      `INSERT INTO ${OTP_NUMBER} (
        id, title, number, session_id, status, qr_code, session_path,
        last_connected, messages_sent, is_active, plan_id, plan_status,
        message_balance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id,
        String(data.name || '').trim(),
        data.phone || null,
        String(data.clientId || '').trim(),
        data.status || 'disconnected',
        data.qrCode || null,
        data.sessionPath || null,
        data.lastConnected || null,
        data.messagesSent || 0,
        data.isActive === undefined ? 1 : (data.isActive ? 1 : 0),
        data.planId || null,
        data.planStatus || 'none',
        data.messageBalance || 0
      ]
    );

    if (data.userId) {
      await this.addUser(id, data.userId);
    }

    return this.findOne({ _id: id });
  }

  static async findByIdAndUpdate(id, update = {}, options = {}) {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  static async findOneAndUpdate(filter, update = {}, options = {}) {
    const current = await this.findOne(filter);
    if (!current) return null;

    const { set, values } = buildUpdate(update);
    if (set.length === 0) return options.new ? current : null;

    await query(
      `UPDATE ${OTP_NUMBER} SET ${set.join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, current._id]
    );

    if (options.new) return this.findOne({ _id: current._id });
    return current;
  }

  static async getBalance(id) {
    const rows = await query(
      `SELECT message_balance FROM ${OTP_NUMBER} WHERE id = ? LIMIT 1`,
      [String(id)]
    );
    return rows[0]?.message_balance ?? 0;
  }

  static async updateBalance(id, newBalance) {
    await query(
      `UPDATE ${OTP_NUMBER} SET message_balance = ?, updated_at = NOW() WHERE id = ?`,
      [Math.max(0, parseInt(newBalance, 10) || 0), String(id)]
    );
    return this.findOne({ _id: id });
  }

  /** Soft-delete: hide from pool and stop using the session. */
  static async softDelete(id) {
    const current = await this.findOne({ _id: id, isActive: true });
    if (!current) return null;
    await this.clearUsers(id);
    await query(
      `UPDATE ${OTP_NUMBER}
       SET is_active = 0, status = 'disconnected', qr_code = NULL, updated_at = NOW()
       WHERE id = ?`,
      [String(id)]
    );
    return this.findOne({ _id: id });
  }

  static async decrementBalance(id, amount = 1) {
    await query(
      `UPDATE ${OTP_NUMBER}
       SET message_balance = GREATEST(message_balance - ?, 0), updated_at = NOW()
       WHERE id = ?`,
      [amount, String(id)]
    );
    return this.getBalance(id);
  }

  static async setPlan(id, planId, status = 'active') {
    await query(
      `UPDATE ${OTP_NUMBER} SET plan_id = ?, plan_status = ?, updated_at = NOW() WHERE id = ?`,
      [planId ? String(planId) : null, String(status || 'none'), String(id)]
    );
    return this.findOne({ _id: id });
  }

  static async isAssignedTo(id, userId) {
    if (!id || !userId) return false;
    const rows = await query(
      `SELECT 1 AS ok FROM ${APP} WHERE OTP_NUMBER_id = ? AND client_id = ? AND \`Active\` = 1 LIMIT 1`,
      [String(id), String(userId)]
    );
    return rows.length > 0;
  }

  static async listAssignedUserIds(id) {
    const rows = await query(
      `SELECT DISTINCT client_id FROM ${APP} WHERE OTP_NUMBER_id = ? AND \`Active\` = 1 ORDER BY created_at ASC`,
      [String(id)]
    );
    return rows.map((row) => String(row.client_id));
  }

  static async listAssignedUsers(id) {
    const rows = await query(
      `SELECT c.id, c.name, c.email, MIN(a.created_at) AS assigned_at
       FROM ${APP} a
       INNER JOIN ${CLIENT} c ON c.id = a.client_id
       WHERE a.OTP_NUMBER_id = ? AND a.\`Active\` = 1
       GROUP BY c.id, c.name, c.email
       ORDER BY assigned_at ASC`,
      [String(id)]
    );
    return rows.map((row) => ({
      _id: row.id,
      name: row.name,
      email: row.email,
      assignedAt: row.assigned_at
    }));
  }

  static async listAssignedUsersByNumberIds(ids = []) {
    const unique = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
    if (unique.length === 0) return {};
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await query(
      `SELECT a.OTP_NUMBER_id AS phone_number_id, c.id, c.name, c.email, MIN(a.created_at) AS assigned_at
       FROM ${APP} a
       INNER JOIN ${CLIENT} c ON c.id = a.client_id
       WHERE a.OTP_NUMBER_id IN (${placeholders}) AND a.\`Active\` = 1
       GROUP BY a.OTP_NUMBER_id, c.id, c.name, c.email
       ORDER BY assigned_at ASC`,
      unique
    );
    const map = {};
    for (const row of rows) {
      const key = String(row.phone_number_id);
      if (!map[key]) map[key] = [];
      map[key].push({
        _id: row.id,
        name: row.name,
        email: row.email,
        assignedAt: row.assigned_at
      });
    }
    return map;
  }

  static async addUser(id, userId) {
    const App = require('./App');
    const User = require('./User');
    const app = await App.assignToClient(userId, id);
    const apps = await App.listForClient(userId, { activeOnly: true });
    const owner = await User.findById(userId);
    if (app && (!owner?.currentAppId || apps.length === 1)) {
      await App.setCurrent(userId, app._id);
    }
    if (apps.length >= 2) {
      await User.setAllowSourceSwitch(userId, true);
    }
    return this.findOne({ _id: id });
  }

  static async removeUser(id, userId) {
    const App = require('./App');
    await App.deactivateForAssignment(userId, id);
    return this.findOne({ _id: id });
  }

  static async clearUsers(id) {
    const App = require('./App');
    await App.deactivateForAssignment(null, id);
    return this.findOne({ _id: id });
  }

  static async assignUser(id, userId) {
    if (!userId) return this.clearUsers(id);
    return this.addUser(id, userId);
  }
}

module.exports = WhatsAppClientModel;
