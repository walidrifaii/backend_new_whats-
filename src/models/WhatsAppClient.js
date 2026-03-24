const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.user_id,
    name: row.name,
    phone: row.phone,
    clientId: row.client_id,
    status: row.status,
    qrCode: row.qr_code,
    sessionPath: row.session_path,
    lastConnected: row.last_connected,
    messagesSent: row.messages_sent,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

const buildFilter = (filter = {}) => {
  const clauses = [];
  const values = [];

  if (filter._id !== undefined) {
    clauses.push('id = ?');
    values.push(String(filter._id));
  }
  if (filter.userId !== undefined) {
    clauses.push('user_id = ?');
    values.push(String(filter.userId));
  }
  if (filter.isActive !== undefined) {
    clauses.push('is_active = ?');
    values.push(filter.isActive ? 1 : 0);
  }
  if (filter.clientId !== undefined) {
    clauses.push('client_id = ?');
    values.push(String(filter.clientId));
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    values.push(String(filter.status));
  }

  return { clauses, values };
};

const buildUpdate = (update = {}) => {
  const set = [];
  const values = [];

  const map = {
    userId: 'user_id',
    name: 'name',
    phone: 'phone',
    clientId: 'client_id',
    status: 'status',
    qrCode: 'qr_code',
    sessionPath: 'session_path',
    lastConnected: 'last_connected',
    messagesSent: 'messages_sent',
    isActive: 'is_active'
  };

  Object.entries(update).forEach(([key, value]) => {
    if (key === '$inc' || value === undefined) return;
    const column = map[key];
    if (!column) return;
    set.push(`${column} = ?`);
    if (key === 'isActive') values.push(value ? 1 : 0);
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
  static async find(filter = {}, options = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = `
      SELECT id, user_id, name, phone, client_id, status, qr_code, session_path,
             last_connected, messages_sent, is_active, created_at, updated_at
      FROM whatsapp_clients
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;

    if (options.sort?.createdAt === -1) sql += ' ORDER BY created_at DESC';
    else if (options.sort?.createdAt === 1) sql += ' ORDER BY created_at ASC';
    else sql += ' ORDER BY created_at DESC';

    if (options.limit !== undefined && options.limit !== null) {
      const limit = Number(options.limit);
      if (Number.isFinite(limit) && limit > 0) {
        // Keep LIMIT as a numeric literal to avoid prepared-statement
        // argument issues seen on some MySQL/MariaDB deployments.
        sql += ` LIMIT ${Math.floor(limit)}`;
      }
    }

    const rows = await query(sql, values);
    return rows.map(mapRow);
  }

  static async findOne(filter = {}) {
    const rows = await this.find(filter, { limit: 1, sort: { createdAt: -1 } });
    return rows[0] || null;
  }

  static async create(data) {
    const id = generateObjectId();
    const userId = String(data.userId || '').trim();
    if (!userId) {
      throw new Error('userId is required');
    }

    await query(
      `INSERT INTO whatsapp_clients (
        id, user_id, name, phone, client_id, status, qr_code, session_path,
        last_connected, messages_sent, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id,
        userId,
        String(data.name || '').trim(),
        data.phone || null,
        String(data.clientId || '').trim(),
        data.status || 'disconnected',
        data.qrCode || null,
        data.sessionPath || null,
        data.lastConnected || null,
        data.messagesSent || 0,
        data.isActive === undefined ? 1 : (data.isActive ? 1 : 0)
      ]
    );
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
      `UPDATE whatsapp_clients SET ${set.join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, current._id]
    );

    if (options.new) return this.findOne({ _id: current._id });
    return current;
  }
}

module.exports = WhatsAppClientModel;
