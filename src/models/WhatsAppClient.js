const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const SELECT_COLUMNS = `
  pn.id, pn.name, pn.phone, pn.client_id, pn.status, pn.qr_code, pn.session_path,
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
    clauses.push('pn.client_id = ?');
    values.push(String(filter.clientId));
  }
  if (filter.phone !== undefined) {
    clauses.push('pn.phone = ?');
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
    name: 'name',
    phone: 'phone',
    clientId: 'client_id',
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
    const rows = await query(
      `SELECT 1 AS ok
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       LIMIT 1`,
      [name]
    );
    return rows.length > 0;
  }

  static async columnExists(table, column) {
    const rows = await query(
      `SELECT 1 AS ok
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
       LIMIT 1`,
      [table, column]
    );
    return rows.length > 0;
  }

  static async ensureTable() {
    const hasNew = await this.tableExists('phone_numbers');
    const hasOld = await this.tableExists('whatsapp_clients');
    if (hasOld && !hasNew) {
      await query('RENAME TABLE whatsapp_clients TO phone_numbers');
    }

    await query(`
      CREATE TABLE IF NOT EXISTS phone_numbers (
        id CHAR(24) NOT NULL,
        name VARCHAR(160) NOT NULL,
        phone VARCHAR(40) NULL,
        client_id VARCHAR(190) NOT NULL,
        status ENUM('disconnected', 'initializing', 'qr_ready', 'connected', 'auth_failure')
          NOT NULL DEFAULT 'disconnected',
        qr_code LONGTEXT NULL,
        session_path VARCHAR(500) NULL,
        last_connected DATETIME NULL,
        messages_sent INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        plan_id CHAR(24) NULL,
        plan_status VARCHAR(16) NOT NULL DEFAULT 'none',
        message_balance INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_phone_numbers_client_id (client_id),
        KEY idx_phone_numbers_plan_id (plan_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  static async ensureAssignmentTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS phone_number_users (
        phone_number_id CHAR(24) NOT NULL,
        user_id CHAR(24) NOT NULL,
        assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (phone_number_id, user_id),
        KEY idx_phone_number_users_user_id (user_id),
        CONSTRAINT fk_phone_number_users_number
          FOREIGN KEY (phone_number_id) REFERENCES phone_numbers (id)
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_phone_number_users_user
          FOREIGN KEY (user_id) REFERENCES users (id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  static async dropPhoneNumberUserFks() {
    try {
      const fks = await query(`
        SELECT CONSTRAINT_NAME AS name
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'phone_numbers'
          AND CONSTRAINT_TYPE = 'FOREIGN KEY'
          AND CONSTRAINT_NAME LIKE '%user%'
      `);
      for (const row of fks) {
        try {
          await query(`ALTER TABLE phone_numbers DROP FOREIGN KEY \`${row.name}\``);
        } catch (err) {
          if (!ignoreMissing(err)) throw err;
        }
      }
    } catch (err) {
      if (!ignoreDup(err) && err.code !== 'ER_BAD_TABLE_ERROR') throw err;
    }
  }

  static async migrateUserPlansOntoNumbers() {
    if (!(await this.columnExists('phone_numbers', 'user_id'))) return;

    await query(`
      UPDATE phone_numbers wc
      INNER JOIN users u ON u.id = wc.user_id
      SET
        wc.plan_id = COALESCE(wc.plan_id, u.plan_id),
        wc.plan_status = CASE
          WHEN wc.plan_status IS NULL OR wc.plan_status = 'none'
            THEN COALESCE(NULLIF(u.plan_status, ''), 'none')
          ELSE wc.plan_status
        END
      WHERE wc.user_id IS NOT NULL
        AND wc.plan_id IS NULL
        AND u.plan_id IS NOT NULL
    `);

    await query(`
      UPDATE phone_numbers wc
      INNER JOIN (
        SELECT user_id, MAX(created_at) AS created_at
        FROM phone_numbers
        WHERE user_id IS NOT NULL AND is_active = 1
        GROUP BY user_id
      ) latest ON latest.user_id = wc.user_id AND latest.created_at = wc.created_at
      INNER JOIN users u ON u.id = wc.user_id
      SET wc.message_balance = u.message_balance
      WHERE wc.message_balance = 0
        AND u.message_balance > 0
    `);
  }

  static async copyLegacyAssignments() {
    if (!(await this.columnExists('phone_numbers', 'user_id'))) return;

    const assignedAtSelect = (await this.columnExists('phone_numbers', 'assigned_at'))
      ? 'COALESCE(pn.assigned_at, pn.created_at)'
      : 'pn.created_at';

    await query(`
      INSERT IGNORE INTO phone_number_users (phone_number_id, user_id, assigned_at)
      SELECT pn.id, pn.user_id, ${assignedAtSelect}
      FROM phone_numbers pn
      INNER JOIN users u ON u.id = pn.user_id
      WHERE pn.user_id IS NOT NULL
    `);
  }

  static async dropLegacyUserColumn() {
    await this.dropPhoneNumberUserFks();

    try {
      await query('ALTER TABLE phone_numbers DROP INDEX idx_phone_numbers_user_id');
    } catch (err) {
      if (!ignoreMissing(err) && !ignoreDup(err)) throw err;
    }

    for (const column of ['user_id', 'assigned_at']) {
      if (!(await this.columnExists('phone_numbers', column))) continue;
      try {
        await query(`ALTER TABLE phone_numbers DROP COLUMN ${column}`);
      } catch (err) {
        if (!ignoreMissing(err)) throw err;
      }
    }
  }

  static async ensurePoolColumns() {
    await this.ensureTable();

    const columns = [
      [`plan_id`, `CHAR(24) NULL`],
      [`plan_status`, `VARCHAR(16) NOT NULL DEFAULT 'none'`],
      [`message_balance`, `INT NOT NULL DEFAULT 0`]
    ];
    for (const [name, def] of columns) {
      try {
        await query(`ALTER TABLE phone_numbers ADD COLUMN ${name} ${def}`);
      } catch (err) {
        if (!ignoreDup(err)) throw err;
      }
    }

    try {
      await query('CREATE INDEX idx_phone_numbers_plan_id ON phone_numbers (plan_id)');
    } catch (err) {
      if (!ignoreDup(err)) throw err;
    }

    await this.migrateUserPlansOntoNumbers();
    await this.ensureAssignmentTable();
    await this.copyLegacyAssignments();
    await this.dropLegacyUserColumn();
  }

  static assignmentJoin(filter = {}) {
    if (filter.userId === null) {
      return {
        join: 'LEFT JOIN phone_number_users pnu ON pnu.phone_number_id = pn.id',
        clause: 'pnu.user_id IS NULL',
        values: []
      };
    }
    if (filter.userId !== undefined) {
      return {
        join: 'INNER JOIN phone_number_users pnu ON pnu.phone_number_id = pn.id AND pnu.user_id = ?',
        clause: null,
        values: [String(filter.userId)]
      };
    }
    return { join: '', clause: null, values: [] };
  }

  static async find(filter = {}, options = {}) {
    const { clauses, values } = buildFilter(filter);
    const assignment = this.assignmentJoin(filter);
    let sql = `SELECT ${SELECT_COLUMNS} FROM phone_numbers pn ${assignment.join}`;
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
      `INSERT INTO phone_numbers (
        id, name, phone, client_id, status, qr_code, session_path,
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
      `UPDATE phone_numbers SET ${set.join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, current._id]
    );

    if (options.new) return this.findOne({ _id: current._id });
    return current;
  }

  static async getBalance(id) {
    const rows = await query(
      `SELECT message_balance FROM phone_numbers WHERE id = ? LIMIT 1`,
      [String(id)]
    );
    return rows[0]?.message_balance ?? 0;
  }

  static async updateBalance(id, newBalance) {
    await query(
      `UPDATE phone_numbers SET message_balance = ?, updated_at = NOW() WHERE id = ?`,
      [Math.max(0, parseInt(newBalance, 10) || 0), String(id)]
    );
    return this.findOne({ _id: id });
  }

  static async decrementBalance(id, amount = 1) {
    await query(
      `UPDATE phone_numbers
       SET message_balance = GREATEST(message_balance - ?, 0), updated_at = NOW()
       WHERE id = ?`,
      [amount, String(id)]
    );
    return this.getBalance(id);
  }

  static async setPlan(id, planId, status = 'active') {
    await query(
      `UPDATE phone_numbers SET plan_id = ?, plan_status = ?, updated_at = NOW() WHERE id = ?`,
      [planId ? String(planId) : null, String(status || 'none'), String(id)]
    );
    return this.findOne({ _id: id });
  }

  static async isAssignedTo(id, userId) {
    if (!id || !userId) return false;
    const rows = await query(
      `SELECT 1 AS ok FROM phone_number_users WHERE phone_number_id = ? AND user_id = ? LIMIT 1`,
      [String(id), String(userId)]
    );
    return rows.length > 0;
  }

  static async listAssignedUserIds(id) {
    const rows = await query(
      `SELECT user_id FROM phone_number_users WHERE phone_number_id = ? ORDER BY assigned_at ASC`,
      [String(id)]
    );
    return rows.map((row) => String(row.user_id));
  }

  static async listAssignedUsers(id) {
    const rows = await query(
      `SELECT u.id, u.name, u.email, pnu.assigned_at
       FROM phone_number_users pnu
       INNER JOIN users u ON u.id = pnu.user_id
       WHERE pnu.phone_number_id = ?
       ORDER BY pnu.assigned_at ASC`,
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
      `SELECT pnu.phone_number_id, u.id, u.name, u.email, pnu.assigned_at
       FROM phone_number_users pnu
       INNER JOIN users u ON u.id = pnu.user_id
       WHERE pnu.phone_number_id IN (${placeholders})
       ORDER BY pnu.assigned_at ASC`,
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
    await query(
      `INSERT IGNORE INTO phone_number_users (phone_number_id, user_id, assigned_at)
       VALUES (?, ?, NOW())`,
      [String(id), String(userId)]
    );
    const App = require('./App');
    await App.assignToClient(userId, id);
    return this.findOne({ _id: id });
  }

  static async removeUser(id, userId) {
    await query(
      `DELETE FROM phone_number_users WHERE phone_number_id = ? AND user_id = ?`,
      [String(id), String(userId)]
    );
    const App = require('./App');
    await App.deactivateForAssignment(userId, id);
    return this.findOne({ _id: id });
  }

  static async clearUsers(id) {
    await query(
      `DELETE FROM phone_number_users WHERE phone_number_id = ?`,
      [String(id)]
    );
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
