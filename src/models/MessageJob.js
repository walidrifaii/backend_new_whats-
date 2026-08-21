const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    message: row.message,
    mediaUrl: row.media_url,
    status: row.status,
    minDelay: row.min_delay,
    maxDelay: row.max_delay,
    spreadHours: row.spread_hours,
    estimatedCompletedAt: row.estimated_completed_at,
    totalCount: row.total_count,
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
    message: 'message',
    mediaUrl: 'media_url',
    status: 'status',
    minDelay: 'min_delay',
    maxDelay: 'max_delay',
    spreadHours: 'spread_hours',
    estimatedCompletedAt: 'estimated_completed_at',
    totalCount: 'total_count',
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

class MessageJobModel {
  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS message_jobs (
        id CHAR(24) NOT NULL,
        user_id CHAR(24) NOT NULL,
        client_id CHAR(24) NOT NULL,
        message TEXT NOT NULL,
        media_url VARCHAR(2048) NULL,
        status ENUM('queued', 'running', 'completed', 'failed', 'cancelled')
          NOT NULL DEFAULT 'queued',
        min_delay INT NOT NULL DEFAULT 20000,
        max_delay INT NOT NULL DEFAULT 30000,
        spread_hours DECIMAL(8,2) NOT NULL DEFAULT 16,
        estimated_completed_at DATETIME NULL,
        total_count INT NOT NULL DEFAULT 0,
        sent_count INT NOT NULL DEFAULT 0,
        failed_count INT NOT NULL DEFAULT 0,
        pending_count INT NOT NULL DEFAULT 0,
        started_at DATETIME NULL,
        completed_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_message_jobs_user_id (user_id),
        KEY idx_message_jobs_client_id (client_id),
        KEY idx_message_jobs_status (status),
        CONSTRAINT fk_message_jobs_user
          FOREIGN KEY (user_id) REFERENCES users (id)
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_message_jobs_client
          FOREIGN KEY (client_id) REFERENCES phone_numbers (id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS message_job_items (
        id CHAR(24) NOT NULL,
        job_id CHAR(24) NOT NULL,
        user_id CHAR(24) NOT NULL,
        phone VARCHAR(40) NOT NULL,
        status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
        whatsapp_message_id VARCHAR(255) NULL,
        error TEXT NULL,
        scheduled_at DATETIME NULL,
        sent_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_message_job_items_job_status (job_id, status),
        KEY idx_message_job_items_user_id (user_id),
        KEY idx_message_job_items_scheduled (job_id, status, scheduled_at),
        CONSTRAINT fk_message_job_items_job
          FOREIGN KEY (job_id) REFERENCES message_jobs (id)
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_message_job_items_user
          FOREIGN KEY (user_id) REFERENCES users (id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.ensureExtraColumns();
  }

  static async ensureExtraColumns() {
    const alters = [
      `ALTER TABLE message_jobs ADD COLUMN spread_hours DECIMAL(8,2) NOT NULL DEFAULT 16`,
      `ALTER TABLE message_jobs ADD COLUMN estimated_completed_at DATETIME NULL`
    ];
    for (const sql of alters) {
      try {
        await query(sql);
      } catch (err) {
        if (!(err.code === 'ER_DUP_FIELDNAME' || String(err.message || '').includes('Duplicate column'))) {
          throw err;
        }
      }
    }

    const MessageJobItem = require('./MessageJobItem');
    await MessageJobItem.ensureColumns();
  }

  static async findOne(filter = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = `
      SELECT id, user_id, client_id, message, media_url, status,
             min_delay, max_delay, spread_hours, estimated_completed_at,
             total_count, sent_count, failed_count,
             pending_count, started_at, completed_at, created_at, updated_at
      FROM message_jobs
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC LIMIT 1';
    const rows = await query(sql, values);
    return mapRow(rows[0]);
  }

  static async findById(id) {
    return this.findOne({ _id: id });
  }

  static async create(data) {
    const id = generateObjectId();
    const totalCount = data.totalCount || 0;
    const sentCount = data.sentCount || 0;
    const failedCount = data.failedCount || 0;
    const pendingCount = totalCount - sentCount - failedCount;

    await query(
      `INSERT INTO message_jobs (
        id, user_id, client_id, message, media_url, status,
        min_delay, max_delay, spread_hours, estimated_completed_at,
        total_count, sent_count, failed_count, pending_count,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id,
        String(data.userId),
        String(data.clientId),
        String(data.message || ''),
        data.mediaUrl || null,
        data.status || 'queued',
        data.minDelay ?? 20000,
        data.maxDelay ?? 30000,
        data.spreadHours ?? 16,
        data.estimatedCompletedAt || null,
        totalCount,
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
        `UPDATE message_jobs
         SET ${set.join(', ')},
             pending_count = total_count - sent_count - failed_count,
             updated_at = NOW()
         WHERE id = ?`,
        [...values, id]
      );
    }
    return options.new ? this.findById(id) : current;
  }
}

module.exports = MessageJobModel;
