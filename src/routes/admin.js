const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Plan = require('../models/Plan');
const UserSource = require('../models/UserSource');
const { query } = require('../db/mysql');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { getOwnerSubscription, serializeSubscription, assignPlanToOwner } = require('../utils/subscription');
const { normalizeMessageSource } = require('../utils/messageSource');

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
        failedCount: s.failed_count,
        bySource: []
      };
    }

    const sourceStats = await query(`
      SELECT user_id,
        COALESCE(NULLIF(source, ''), '_untagged') AS source,
        COUNT(*) AS total_messages,
        SUM(CASE WHEN status = 'sent' AND direction = 'outgoing' THEN 1 ELSE 0 END) AS sent_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM message_logs
      GROUP BY user_id, COALESCE(NULLIF(source, ''), '_untagged')
    `);
    for (const s of sourceStats) {
      if (!statsMap[s.user_id]) {
        statsMap[s.user_id] = { totalMessages: 0, sentCount: 0, failedCount: 0, bySource: [] };
      }
      statsMap[s.user_id].bySource.push({
        source: s.source,
        totalMessages: s.total_messages,
        sentCount: s.sent_count,
        failedCount: s.failed_count
      });
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
      if (u.parentUserId && u.source) {
        const parentStats = statsMap[u.parentUserId];
        const src = (parentStats?.bySource || []).find((row) => row.source === u.source);
        safe.stats = {
          totalMessages: src?.totalMessages || 0,
          sentCount: src?.sentCount || 0,
          failedCount: src?.failedCount || 0,
          bySource: src ? [src] : []
        };
        safe.clientCount = clientMap[u.parentUserId] || 0;
      } else {
        safe.stats = statsMap[u._id] || { totalMessages: 0, sentCount: 0, failedCount: 0, bySource: [] };
        safe.clientCount = clientMap[u._id] || 0;
      }
      return safe;
    });

    const ownerIds = [...new Set(result.map((u) => u.parentUserId || u._id))];
    const plans = await Plan.findAll();
    const plansById = new Map(plans.map((p) => [p._id, p]));
    const sourcesByOwner = {};
    const catalogByOwner = {};
    for (const ownerId of ownerIds) {
      if (!ownerId) continue;
      sourcesByOwner[ownerId] = await UserSource.listByUser(ownerId);
      catalogByOwner[ownerId] = await UserSource.listKnownNames(ownerId);
    }
    for (const row of result) {
      const ownerId = row.parentUserId || row._id;
      const plan = plansById.get(row.planId);
      const ownerSources = sourcesByOwner[ownerId] || [];
      row.plan = plan || null;
      row.enabledSources = ownerSources
        .filter((item) => item.enabled)
        .map((item) => item.source);
      row.sourceCatalog = catalogByOwner[ownerId] || [];
    }

    res.json({ users: result, plans });
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

// POST /api/admin/users/:id/service-accounts — create a locked source login on this WhatsApp owner
router.post('/users/:id/service-accounts', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('source').trim().notEmpty().withMessage('Source is required'),
  body('messageBalance').optional().isInt({ min: 0 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const parent = await User.findById(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Owner account not found' });
    if (parent.parentUserId) {
      return res.status(400).json({ error: 'Cannot attach a service login to another service login. Use the WhatsApp owner account.' });
    }

    const user = await User.createServiceAccount({
      parent,
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      source: req.body.source,
      messageBalance: req.body.messageBalance
    });

    res.status(201).json({
      user: user.toJSON(),
      message: `Service login created for source "${user.source}". They share this owner's WhatsApp.`
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/plans
router.get('/plans', async (_req, res) => {
  try {
    const plans = await Plan.findAll();
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/plans
router.post('/plans', [
  body('name').trim().notEmpty().withMessage('Plan name is required'),
  body('messageQuota').isInt({ min: 1 }).withMessage('Message quota must be at least 1'),
  body('sourceLimit').isInt({ min: 1, max: 10 }).withMessage('Source limit must be 1-10')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const plan = await Plan.create({
      name: req.body.name,
      slug: req.body.slug,
      messageQuota: req.body.messageQuota,
      sourceLimit: req.body.sourceLimit,
      isActive: req.body.isActive,
      sortOrder: req.body.sortOrder
    });
    res.status(201).json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/plans/:id
router.patch('/plans/:id', async (req, res) => {
  try {
    const existing = await Plan.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });
    const plan = await Plan.update(req.params.id, {
      name: req.body.name,
      slug: req.body.slug,
      messageQuota: req.body.messageQuota,
      sourceLimit: req.body.sourceLimit,
      isActive: req.body.isActive,
      sortOrder: req.body.sortOrder
    });
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/plan — assign or clear a plan
router.patch('/users/:id/plan', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.parentUserId) {
      return res.status(400).json({ error: 'Assign the plan on the WhatsApp owner account, not the service login.' });
    }

    const planId = req.body.planId ? String(req.body.planId) : '';
    if (!planId) {
      await User.setPlan(user._id, null, 'none');
      const sub = await getOwnerSubscription(user._id);
      return res.json({
        user: (await User.findById(user._id)).toJSON(),
        subscription: serializeSubscription(sub, user),
        message: 'Plan removed'
      });
    }

    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const refillBalance = req.body.refillBalance !== false;
    const sub = await assignPlanToOwner(user, plan, { refillBalance });
    const updated = await User.findById(user._id);
    res.json({
      user: updated.toJSON(),
      subscription: serializeSubscription(sub, updated),
      message: `Assigned ${plan.name} (${plan.messageQuota} messages, ${plan.sourceLimit} sources)`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/sources — enable sources up to the plan limit
router.patch('/users/:id/sources', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ownerId = user.parentUserId || user._id;
    const owner = user.parentUserId ? await User.findById(user.parentUserId) : user;
    const sub = await getOwnerSubscription(ownerId);
    const wanted = (Array.isArray(req.body.sources) ? req.body.sources : [])
      .map((item) => normalizeMessageSource(item))
      .filter(Boolean);

    const limit = sub.plan?.sourceLimit || (sub.status === 'active' ? 1 : wanted.length);
    if (sub.status === 'active' && wanted.length > limit) {
      return res.status(400).json({
        error: `${sub.plan?.name || 'This'} plan allows ${limit} source(s). Disable one before enabling another.`
      });
    }

    const sources = await UserSource.setEnabledSources(ownerId, wanted);
    const next = await getOwnerSubscription(ownerId);
    res.json({
      sources,
      enabledSources: next.enabledSources,
      subscription: serializeSubscription(next, owner),
      message: 'Sources updated'
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/source-lock
// null source = this email can switch among the owner's enabled sources
router.patch('/users/:id/source-lock', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.parentUserId) {
      return res.status(400).json({
        error: 'The owner already switches from /stats. Enable sources on this owner with Sources.'
      });
    }

    const raw = req.body.source;
    const lockTo = raw == null || raw === '' ? null : normalizeMessageSource(raw);
    if (raw && !lockTo) {
      return res.status(400).json({ error: 'Invalid source name' });
    }

    if (lockTo) {
      const sibling = await User.findOne({ parentUserId: user.parentUserId, source: lockTo });
      if (sibling && String(sibling._id) !== String(user._id)) {
        return res.status(400).json({
          error: `Another login is already locked to "${lockTo}".`
        });
      }
    }

    const updated = await User.setLockedSource(user._id, lockTo);
    const next = await getOwnerSubscription(user.parentUserId);
    res.json({
      user: updated.toJSON(),
      enabledSources: next.enabledSources,
      message: lockTo
        ? `This login is locked to ${lockTo} and cannot switch.`
        : (next.enabledSources.length >= 2
          ? `This email can switch sources. Enabled: ${next.enabledSources.join(', ')}.`
          : 'Source lock removed. Enable at least 2 real sources on the owner so they can switch.')
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
