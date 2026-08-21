const { query } = require('../db/mysql');
const { generateObjectId } = require('../utils/objectId');
const { PLAN } = require('../db/tables');

const mapRow = (row) => {
  if (!row) return null;
  return {
    _id: row.id,
    name: row.name,
    slug: row.slug,
    messageQuota: Number(row.credits ?? row.message_quota) || 0,
    amount: Number(row.amount) || 0,
    sourceLimit: Number(row.source_limit) || 1,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

class PlanModel {
  static async ensureTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS ${PLAN} (
        id CHAR(24) NOT NULL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        credits INT NOT NULL DEFAULT 0,
        amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        source_limit INT NOT NULL DEFAULT 1,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        slug VARCHAR(32) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_plan_slug (slug)
      )
    `);
    await this.seedDefaults();
  }

  static async seedDefaults() {
    const rows = await query(`SELECT COUNT(*) AS total FROM ${PLAN}`);
    if ((rows[0]?.total || 0) > 0) return;

    const defaults = [
      { name: 'Mini', slug: 'mini', messageQuota: 500, sourceLimit: 1, sortOrder: 1 },
      { name: 'Medium', slug: 'medium', messageQuota: 1000, sourceLimit: 2, sortOrder: 2 },
      { name: 'Max', slug: 'max', messageQuota: 1500, sourceLimit: 3, sortOrder: 3 }
    ];
    for (const plan of defaults) {
      await this.create(plan);
    }
  }

  static async findAll({ activeOnly = false } = {}) {
    const sql = activeOnly
      ? `SELECT * FROM ${PLAN} WHERE is_active = 1 ORDER BY sort_order ASC, name ASC`
      : `SELECT * FROM ${PLAN} ORDER BY sort_order ASC, name ASC`;
    const rows = await query(sql);
    return rows.map(mapRow);
  }

  static async findById(id) {
    const rows = await query(`SELECT * FROM ${PLAN} WHERE id = ? LIMIT 1`, [String(id)]);
    return mapRow(rows[0]);
  }

  static async findBySlug(slug) {
    const rows = await query(`SELECT * FROM ${PLAN} WHERE slug = ? LIMIT 1`, [String(slug)]);
    return mapRow(rows[0]);
  }

  static async create(data) {
    const id = generateObjectId();
    const name = String(data.name || '').trim();
    const slug = String(data.slug || name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    const messageQuota = Math.max(1, parseInt(data.messageQuota, 10) || 500);
    const sourceLimit = Math.max(1, Math.min(10, parseInt(data.sourceLimit, 10) || 1));
    const isActive = data.isActive === undefined ? 1 : (data.isActive ? 1 : 0);
    const sortOrder = parseInt(data.sortOrder, 10) || 0;

    await query(
      `INSERT INTO ${PLAN} (id, name, slug, credits, source_limit, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, slug, messageQuota, sourceLimit, isActive, sortOrder]
    );
    return this.findById(id);
  }

  static async update(id, data = {}) {
    const set = [];
    const values = [];
    if (data.name !== undefined) {
      set.push('name = ?');
      values.push(String(data.name).trim());
    }
    if (data.slug !== undefined) {
      set.push('slug = ?');
      values.push(String(data.slug).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32));
    }
    if (data.messageQuota !== undefined) {
      set.push('credits = ?');
      values.push(Math.max(1, parseInt(data.messageQuota, 10) || 1));
    }
    if (data.sourceLimit !== undefined) {
      set.push('source_limit = ?');
      values.push(Math.max(1, Math.min(10, parseInt(data.sourceLimit, 10) || 1)));
    }
    if (data.isActive !== undefined) {
      set.push('is_active = ?');
      values.push(data.isActive ? 1 : 0);
    }
    if (data.sortOrder !== undefined) {
      set.push('sort_order = ?');
      values.push(parseInt(data.sortOrder, 10) || 0);
    }
    if (set.length === 0) return this.findById(id);

    values.push(String(id));
    await query(`UPDATE ${PLAN} SET ${set.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  }
}

module.exports = PlanModel;
