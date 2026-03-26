const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { query } = require('../db/mysql');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

router.use(authMiddleware, adminMiddleware);

// GET /api/admin/users — list all users with message stats
router.get('/users', async (req, res) => {
  try {
    const users = await User.findAll();

    const stats = await query(`
      SELECT user_id,
        COUNT(*) AS total_messages,
        SUM(CASE WHEN status = 'sent' AND direction = 'outgoing' THEN 1 ELSE 0 END) AS sent_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM message_logs
      GROUP BY user_id
    `);

    const statsMap = {};
    for (const s of stats) {
      statsMap[s.user_id] = {
        totalMessages: s.total_messages,
        sentCount: s.sent_count,
        failedCount: s.failed_count
      };
    }

    const clientCounts = await query(`
      SELECT user_id, COUNT(*) AS count
      FROM whatsapp_clients
      WHERE is_active = 1
      GROUP BY user_id
    `);
    const clientMap = {};
    for (const c of clientCounts) {
      clientMap[c.user_id] = c.count;
    }

    const result = users.map(u => {
      const safe = u.toJSON();
      safe.stats = statsMap[u._id] || { totalMessages: 0, sentCount: 0, failedCount: 0 };
      safe.clientCount = clientMap[u._id] || 0;
      return safe;
    });

    res.json({ users: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/:id — single user details
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: user.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/balance — set message balance
router.patch('/users/:id/balance', [
  body('balance').isInt({ min: 0 }).withMessage('Balance must be a non-negative integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updated = await User.updateBalance(req.params.id, parseInt(req.body.balance));
    res.json({ user: updated.toJSON(), message: `Balance updated to ${req.body.balance}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/add-balance — add to existing balance
router.post('/users/:id/add-balance', [
  body('amount').isInt({ min: 1 }).withMessage('Amount must be a positive integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newBalance = user.messageBalance + parseInt(req.body.amount);
    const updated = await User.updateBalance(req.params.id, newBalance);
    res.json({
      user: updated.toJSON(),
      message: `Added ${req.body.amount} messages. New balance: ${newBalance}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/toggle-active — enable/disable user
router.patch('/users/:id/toggle-active', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newStatus = user.isActive ? 0 : 1;
    await query(`UPDATE users SET is_active = ? WHERE id = ?`, [newStatus, req.params.id]);
    const updated = await User.findById(req.params.id);
    res.json({ user: updated.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats — overall platform stats
router.get('/stats', async (req, res) => {
  try {
    const [userCount] = await query(`SELECT COUNT(*) AS count FROM users`);
    const [activeUsers] = await query(`SELECT COUNT(*) AS count FROM users WHERE is_active = 1`);
    const [clientCount] = await query(`SELECT COUNT(*) AS count FROM whatsapp_clients WHERE is_active = 1`);
    const [connectedClients] = await query(`SELECT COUNT(*) AS count FROM whatsapp_clients WHERE status = 'connected' AND is_active = 1`);
    const [messageStats] = await query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'sent' AND direction = 'outgoing' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS received
      FROM message_logs
    `);

    res.json({
      stats: {
        totalUsers: userCount.count,
        activeUsers: activeUsers.count,
        totalClients: clientCount.count,
        connectedClients: connectedClients.count,
        totalMessages: messageStats.total || 0,
        sentMessages: messageStats.sent || 0,
        failedMessages: messageStats.failed || 0,
        receivedMessages: messageStats.received || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
