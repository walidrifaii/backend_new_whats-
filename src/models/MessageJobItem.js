const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    phone: row.phone,
    status: row.status,
    whatsappMessageId: row.whatsapp_message_id,
    error: row.error,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    createdAt: row.created_at
  };
};

const buildFilter = (filter = {}) => {
  const clauses = [];
  const values = [];
  if (filter._id !== undefined) {
    clauses.push('id = ?');
    values.push(String(filter._id));
  }
  if (filter.jobId !== undefined) {
    clauses.push('job_id = ?');
    values.push(String(filter.jobId));
  }
  if (filter.userId !== undefined) {
    clauses.push('user_id = ?');
    values.push(String(filter.userId));
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    values.push(String(filter.status));
  }
  return { clauses, values };
};

class MessageJobItemModel {
  static async ensureColumns() {
    try {
      await query(`ALTER TABLE message_job_items ADD COLUMN scheduled_at DATETIME NULL`);
    } catch (err) {
      if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
        throw err;
      }
    }
    try {
      await query(
        `CREATE INDEX idx_message_job_items_scheduled ON message_job_items (job_id, status, scheduled_at)`
      );
    } catch (err) {
      if (!(String(err.message || '').includes('Duplicate key') || err.code === 'ER_DUP_KEYNAME')) {
        throw err;
      }
    }
  }

  static async find(filter = {}, options = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = `
      SELECT id, job_id, user_id, phone, status, whatsapp_message_id, error, scheduled_at, sent_at, created_at
      FROM message_job_items
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY scheduled_at ASC, created_at ASC';

    if (options.limit !== undefined && options.limit !== null) {
      const limit = Number(options.limit);
      if (Number.isFinite(limit) && limit > 0) {
        sql += ` LIMIT ${Math.floor(limit)}`;
      }
    }
    if (options.offset !== undefined && options.offset !== null) {
      const offset = Number(options.offset);
      if (Number.isFinite(offset) && offset >= 0) {
        if (!/ LIMIT \d+$/i.test(sql)) {
          sql += ' LIMIT 18446744073709551615';
        }
        sql += ` OFFSET ${Math.floor(offset)}`;
      }
    }

    const rows = await query(sql, values);
    return rows.map(mapRow);
  }

  static async countDocuments(filter = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = 'SELECT COUNT(*) AS total FROM message_job_items';
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    const rows = await query(sql, values);
    return rows[0]?.total || 0;
  }

  static async findEarliestPending(jobId) {
    const rows = await query(
      `SELECT id, job_id, user_id, phone, status, whatsapp_message_id, error, scheduled_at, sent_at, created_at
       FROM message_job_items
       WHERE job_id = ? AND status = 'pending'
       ORDER BY COALESCE(scheduled_at, created_at) ASC, created_at ASC
       LIMIT 1`,
      [String(jobId)]
    );
    return mapRow(rows[0]);
  }

  /** @deprecated use findEarliestPending — kept for compatibility */
  static async findNextDue(jobId) {
    return this.findEarliestPending(jobId);
  }

  static async findNextScheduledAt(jobId) {
    const rows = await query(
      `SELECT scheduled_at
       FROM message_job_items
       WHERE job_id = ? AND status = 'pending' AND scheduled_at > NOW()
       ORDER BY scheduled_at ASC
       LIMIT 1`,
      [String(jobId)]
    );
    return rows[0]?.scheduled_at || null;
  }

  static async insertMany(items = []) {
    if (items.length === 0) return [];

    const placeholders = [];
    const values = [];
    const ids = [];

    items.forEach((item) => {
      const id = generateObjectId();
      ids.push(id);
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())');
      const scheduledAt = item.scheduledAt
        ? (item.scheduledAt instanceof Date
          ? item.scheduledAt
          : new Date(item.scheduledAt))
        : null;
      values.push(
        id,
        item.jobId,
        item.userId,
        item.phone,
        item.status || 'pending',
        item.whatsappMessageId || null,
        item.error || null,
        scheduledAt,
        item.sentAt || null
      );
    });

    await query(
      `INSERT INTO message_job_items (
        id, job_id, user_id, phone, status, whatsapp_message_id, error, scheduled_at, sent_at, created_at
      ) VALUES ${placeholders.join(', ')}`,
      values
    );
    return ids;
  }

  static async findByIdAndUpdate(id, update = {}) {
    const map = {
      jobId: 'job_id',
      userId: 'user_id',
      phone: 'phone',
      status: 'status',
      whatsappMessageId: 'whatsapp_message_id',
      error: 'error',
      scheduledAt: 'scheduled_at',
      sentAt: 'sent_at'
    };
    const set = [];
    const values = [];

    Object.entries(update).forEach(([key, value]) => {
      if (value === undefined) return;
      const column = map[key];
      if (!column) return;
      set.push(`${column} = ?`);
      values.push(value);
    });

    if (set.length === 0) return null;
    await query(`UPDATE message_job_items SET ${set.join(', ')} WHERE id = ?`, [...values, id]);
    const rows = await this.find({ _id: id }, { limit: 1 });
    return rows[0] || null;
  }

  static async failPendingByJobId(jobId, reason) {
    const rows = await query(
      `SELECT COUNT(*) AS total FROM message_job_items WHERE job_id = ? AND status = 'pending'`,
      [String(jobId)]
    );
    const pendingCount = rows[0]?.total || 0;
    if (pendingCount <= 0) return 0;

    await query(
      `UPDATE message_job_items
       SET status = 'failed', error = ?
       WHERE job_id = ? AND status = 'pending'`,
      [reason, String(jobId)]
    );
    return pendingCount;
  }
}

module.exports = MessageJobItemModel;
