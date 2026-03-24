const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.user_id,
    campaignId: row.campaign_id,
    name: row.name,
    phone: row.phone,
    variables: row.variables ? JSON.parse(row.variables) : {},
    status: row.status,
    sentAt: row.sent_at,
    error: row.error,
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
  if (filter.campaignId !== undefined) {
    clauses.push('campaign_id = ?');
    values.push(String(filter.campaignId));
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

class ContactModel {
  static async find(filter = {}, options = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = `
      SELECT id, user_id, campaign_id, name, phone, variables, status, sent_at, error, created_at
      FROM contacts
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;

    if (options.sort?.createdAt === -1) sql += ' ORDER BY created_at DESC';
    else sql += ' ORDER BY created_at ASC';

    if (options.limit !== undefined && options.limit !== null) {
      const limit = Number(options.limit);
      if (Number.isFinite(limit) && limit > 0) {
        // Keep LIMIT/OFFSET as numeric literals to avoid prepared-statement
        // argument issues on some MySQL/MariaDB deployments.
        sql += ` LIMIT ${Math.floor(limit)}`;
      }
    }
    if (options.offset !== undefined && options.offset !== null) {
      const offset = Number(options.offset);
      if (Number.isFinite(offset) && offset >= 0) {
        // MySQL requires LIMIT before OFFSET.
        if (!/ LIMIT \d+$/i.test(sql)) {
          sql += ` LIMIT 18446744073709551615`;
        }
        sql += ` OFFSET ${Math.floor(offset)}`;
      }
    }

    const rows = await query(sql, values);
    return rows.map(mapRow);
  }

  static async countDocuments(filter = {}) {
    const { clauses, values } = buildFilter(filter);
    let sql = 'SELECT COUNT(*) AS total FROM contacts';
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    const rows = await query(sql, values);
    return rows[0]?.total || 0;
  }

  static async create(data) {
    const id = generateObjectId();
    await query(
      `INSERT INTO contacts (
        id, user_id, campaign_id, name, phone, variables, status, sent_at, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id,
        data.userId,
        data.campaignId,
        data.name || '',
        data.phone,
        JSON.stringify(data.variables || {}),
        data.status || 'pending',
        data.sentAt || null,
        data.error || null
      ]
    );
    const rows = await this.find({ _id: id }, { limit: 1 });
    return rows[0] || null;
  }

  static async insertMany(items = []) {
    if (items.length === 0) return [];
    const placeholders = [];
    const values = [];

    items.forEach((item) => {
      const id = generateObjectId();
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())');
      values.push(
        id,
        item.userId,
        item.campaignId,
        item.name || '',
        item.phone,
        JSON.stringify(item.variables || {}),
        item.status || 'pending',
        item.sentAt || null,
        item.error || null
      );
    });

    await query(
      `INSERT INTO contacts (
        id, user_id, campaign_id, name, phone, variables, status, sent_at, error, created_at
      ) VALUES ${placeholders.join(', ')}`,
      values
    );
    return true;
  }

  static async deleteMany(filter = {}) {
    const { clauses, values } = buildFilter(filter);
    if (clauses.length === 0) throw new Error('Contact.deleteMany requires filter');
    await query(`DELETE FROM contacts WHERE ${clauses.join(' AND ')}`, values);
  }

  static async findByIdAndUpdate(id, update = {}) {
    const set = [];
    const values = [];
    const map = {
      userId: 'user_id',
      campaignId: 'campaign_id',
      name: 'name',
      phone: 'phone',
      variables: 'variables',
      status: 'status',
      sentAt: 'sent_at',
      error: 'error'
    };

    Object.entries(update).forEach(([key, value]) => {
      if (value === undefined) return;
      const column = map[key];
      if (!column) return;
      set.push(`${column} = ?`);
      if (key === 'variables') values.push(JSON.stringify(value || {}));
      else values.push(value);
    });

    if (set.length === 0) return null;
    await query(`UPDATE contacts SET ${set.join(', ')} WHERE id = ?`, [...values, id]);
    const rows = await this.find({ _id: id }, { limit: 1 });
    return rows[0] || null;
  }
}

module.exports = ContactModel;
