const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    name: row.name,
    message: row.message,
    mediaUrl: row.media_url,
    mediaType: row.media_type,
    status: row.status,
    minDelay: row.min_delay,
    maxDelay: row.max_delay,
    totalContacts: row.total_contacts,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    pendingCount: row.pending_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
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
    clientId: 'client_id',
    name: 'name',
    message: 'message',
    mediaUrl: 'media_url',
    mediaType: 'media_type',
    status: 'status',
    minDelay: 'min_delay',
    maxDelay: 'max_delay',
    totalContacts: 'total_contacts',
    sentCount: 'sent_count',
    failedCount: 'failed_count',
    pendingCount: 'pending_count',
    startedAt: 'started_at',
    completedAt: 'completed_at'
  };

  Object.entries(update).forEach(([key, value]) => {
    if (key === '$inc' || value === undefined) return;
    const column = map[key];
    if (!column) return;
    set.push(`${column} = ?`);
    values.push(value);
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

class CampaignModel {
  static async find(filter = {}, options = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = `
      SELECT id, user_id, client_id, name, message, media_url, media_type, status,
             min_delay, max_delay, total_contacts, sent_count, failed_count,
             pending_count, started_at, completed_at, created_at, updated_at
      FROM campaigns
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += options.sort?.createdAt === 1 ? ' ORDER BY created_at ASC' : ' ORDER BY created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      values.push(options.limit);
    }

    const rows = await query(sql, values);
    return rows.map(mapRow);
  }

  static async findOne(filter = {}) {
    const rows = await this.find(filter, { limit: 1, sort: { createdAt: -1 } });
    return rows[0] || null;
  }

  static async findById(id) {
    return this.findOne({ _id: id });
  }

  static async create(data) {
    const id = generateObjectId();
    const totalContacts = data.totalContacts || 0;
    const sentCount = data.sentCount || 0;
    const failedCount = data.failedCount || 0;
    const pendingCount = totalContacts - sentCount - failedCount;

    await query(
      `INSERT INTO campaigns (
        id, user_id, client_id, name, message, media_url, media_type, status,
        min_delay, max_delay, total_contacts, sent_count, failed_count, pending_count,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id,
        data.userId,
        data.clientId,
        data.name,
        data.message,
        data.mediaUrl || null,
        data.mediaType || null,
        data.status || 'draft',
        data.minDelay || 20000,
        data.maxDelay || 30000,
        totalContacts,
        sentCount,
        failedCount,
        pendingCount,
        data.startedAt || null,
        data.completedAt || null
      ]
    );
    return this.findById(id);
  }

  static async findByIdAndUpdate(id, update = {}, options = {}) {
    const current = await this.findById(id);
    if (!current) return null;

    const { set, values } = buildUpdate(update);
    if (set.length > 0) {
      await query(
        `UPDATE campaigns
         SET ${set.join(', ')},
             pending_count = total_contacts - sent_count - failed_count,
             updated_at = NOW()
         WHERE id = ?`,
        [...values, id]
      );
    }
    return options.new ? this.findById(id) : current;
  }

  static async findOneAndDelete(filter = {}) {
    const current = await this.findOne(filter);
    if (!current) return null;
    await query('DELETE FROM campaigns WHERE id = ?', [current._id]);
    return current;
  }
}

module.exports = CampaignModel;
