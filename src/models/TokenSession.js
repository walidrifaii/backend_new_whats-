const { query } = require('../db/mysql');
const crypto = require('crypto');

const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

class TokenSessionModel {
  static async init() {
    await query(`
      CREATE TABLE IF NOT EXISTS token_sessions (
        id INT NOT NULL AUTO_INCREMENT,
        token_hash CHAR(64) NOT NULL,
        token TEXT NOT NULL,
        owner_type VARCHAR(20) NOT NULL,
        owner_id VARCHAR(64) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_token_hash (token_hash),
        KEY idx_owner (owner_type, owner_id),
        KEY idx_active_expiry (is_active, expires_at)
      )
    `);
  }

  static async createOrUpdate({ token, ownerType, ownerId, expiresAt }) {
    const tokenHash = hashToken(token);
    await query(
      `INSERT INTO token_sessions (token_hash, token, owner_type, owner_id, is_active, created_at, expires_at)
       VALUES (?, ?, ?, ?, 1, NOW(), ?)
       ON DUPLICATE KEY UPDATE
         token = VALUES(token),
         owner_type = VALUES(owner_type),
         owner_id = VALUES(owner_id),
         is_active = 1,
         expires_at = VALUES(expires_at)`,
      [tokenHash, String(token), String(ownerType), String(ownerId), expiresAt || null]
    );
  }

  static async isValid(token) {
    const tokenHash = hashToken(token);
    const rows = await query(
      `SELECT id
       FROM token_sessions
       WHERE token_hash = ?
         AND is_active = 1
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [tokenHash]
    );
    return rows.length > 0;
  }

  static async revoke(token) {
    const tokenHash = hashToken(token);
    await query(
      `UPDATE token_sessions SET is_active = 0 WHERE token_hash = ?`,
      [tokenHash]
    );
  }
}

module.exports = TokenSessionModel;

