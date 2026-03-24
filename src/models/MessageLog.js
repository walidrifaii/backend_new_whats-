const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    phone: row.phone,
    message: row.message,
    direction: row.direction,
    status: row.status,
    whatsappMessageId: row.whatsapp_message_id,
    error: row.error,
    timestamp: row.timestamp
  };
};

const buildFilter = (filter = {}) => {
  const clauses = [];
  const values = [];
  if (filter.userId !== undefined) {
    clauses.push('ml.user_id = ?');
    values.push(String(filter.userId));
  }
  if (filter.campaignId !== undefined) {
    clauses.push('ml.campaign_id = ?');
    values.push(String(filter.campaignId));
  }
  if (filter.clientId !== undefined) {
    clauses.push('ml.client_id = ?');
    values.push(String(filter.clientId));
  }
  if (filter.direction !== undefined) {
    clauses.push('ml.direction = ?');
    values.push(String(filter.direction));
  }
  if (filter.status !== undefined) {
    clauses.push('ml.status = ?');
    values.push(String(filter.status));
  }
  return { clauses, values };
};

class MessageLogModel {
  static async create(data) {
    const id = generateObjectId();
    await query(
      `INSERT INTO message_logs (
        id, user_id, client_id, campaign_id, contact_id, phone, message, direction,
        status, whatsapp_message_id, error, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id,
        data.userId,
        data.clientId,
        data.campaignId || null,
        data.contactId || null,
        data.phone,
        data.message,
        data.direction || 'outgoing',
        data.status || 'sent',
        data.whatsappMessageId || null,
        data.error || null
      ]
    );
    return { _id: id, ...data };
  }

  static async listWithDetails(filter = {}, options = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = `
      SELECT
        ml.id, ml.user_id, ml.client_id, ml.campaign_id, ml.contact_id,
        ml.phone, ml.message, ml.direction, ml.status,
        ml.whatsapp_message_id, ml.error, ml.timestamp,
        wc.name AS client_name, wc.phone AS client_phone,
        c.name AS campaign_name
      FROM message_logs ml
      LEFT JOIN whatsapp_clients wc ON wc.id = ml.client_id
      LEFT JOIN campaigns c ON c.id = ml.campaign_id
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY ml.timestamp DESC';
    sql += ' LIMIT ? OFFSET ?';
    values.push(Number(options.limit || 50), Number(options.offset || 0));

    const rows = await query(sql, values);
    return rows.map((row) => {
      const mapped = mapRow(row);
      return {
        ...mapped,
        clientId: row.client_name
          ? { _id: mapped.clientId, name: row.client_name, phone: row.client_phone }
          : mapped.clientId,
        campaignId: row.campaign_name
          ? { _id: mapped.campaignId, name: row.campaign_name }
          : mapped.campaignId
      };
    });
  }

  static async countDocuments(filter = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = 'SELECT COUNT(*) AS total FROM message_logs ml';
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    const rows = await query(sql, values);
    return rows[0]?.total || 0;
  }

  static async getStats(filter = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) AS received,
        SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) AS outgoing,
        SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS incoming
      FROM message_logs ml
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    const rows = await query(sql, values);
    return rows[0] || null;
  }
}

module.exports = MessageLogModel;
