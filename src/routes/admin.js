const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Plan = require('../models/Plan');
const UserSource = require('../models/UserSource');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const TokenSession = require('../models/TokenSession');
const { query } = require('../db/mysql');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { createWhatsAppClient, isClientConnected } = require('../services/whatsappManager');
const { getOwnerSubscription, getAccountSubscription, serializeSubscription, assignPlanToUser } = require('../utils/subscription');
const { normalizeMessageSource } = require('../utils/messageSource');
const { buildQrSharePayload } = require('../utils/qrShare');

const resolveOwner = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return null;
  if (user.parentUserId) return User.findById(user.parentUserId);
  return user;
};

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

const createWhatsAppClientForOwner = async (req, owner, { name, phone, source } = {}) => {
  if (!owner) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  if (owner.role === 'admin') {
    const err = new Error('Cannot create a WhatsApp client on an admin login.');
    err.status = 400;
    throw err;
  }

  const sourceName = normalizeMessageSource(source);
  const clientName = String(name || '').trim() || sourceName;
  if (!clientName) {
    const err = new Error('Client name is required');
    err.status = 400;
    throw err;
  }

  const phoneDigits = digitsOnly(phone) || null;

  if (sourceName) {
    const existingSources = await UserSource.listByUser(owner._id);
    const already = existingSources.find((item) => item.source === sourceName);
    if (!already?.enabled) {
      const sub = await getOwnerSubscription(owner._id);
      const enabledCount = existingSources.filter((item) => item.enabled).length;
      const limit = sub.plan?.sourceLimit || (sub.status === 'active' ? 1 : enabledCount + 1);
      if (sub.status === 'active' && enabledCount >= limit) {
        const err = new Error(
          `${sub.plan?.name || 'This'} plan allows ${limit} source(s). Disable one before assigning another.`
        );
        err.status = 400;
        throw err;
      }
    }
    await UserSource.upsert({ userId: owner._id, source: sourceName, enabled: true });

    const existing = await WhatsAppClientModel.findOne({
      userId: owner._id,
      source: sourceName,
      isActive: true
    });

    if (existing) {
      const updates = { status: 'initializing' };
      if (clientName && clientName !== existing.name) updates.name = clientName;
      if (phoneDigits) updates.phone = phoneDigits;
      const client = await WhatsAppClientModel.findByIdAndUpdate(existing._id, updates, { new: true });
      setImmediate(() => {
        createWhatsAppClient(client.clientId).catch((err) => {
          console.error(`Admin init error for ${client.clientId}:`, err);
        });
      });
      return {
        client,
        reused: true,
        qrShare: buildQrSharePayload(req, client.clientId)
      };
    }
  }

  const clientId = `client_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  const createdClient = await WhatsAppClientModel.create({
    userId: owner._id,
    name: clientName,
    phone: phoneDigits,
    clientId,
    source: sourceName || null,
    sessionPath: `./sessions/${clientId}`,
    status: 'disconnected'
  });

  const client = await WhatsAppClientModel.findByIdAndUpdate(
    createdClient._id,
    { status: 'initializing' },
    { new: true }
  );

  setImmediate(() => {
    createWhatsAppClient(client.clientId).catch((err) => {
      console.error(`Admin init error for ${client.clientId}:`, err);
    });
  });

  return {
    client,
    reused: false,
    qrShare: buildQrSharePayload(req, client.clientId)
  };
};

const getPublicApiBase = (req) => {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return host ? `${proto}://${host}/api` : '';
};

const issueAccountToken = async (user) => {
  const token = jwt.sign({ userId: user._id, type: 'user' }, process.env.JWT_SECRET);
  await User.saveToken(user._id, token);
  await TokenSession.createOrUpdate({
    token,
    ownerType: 'user',
    ownerId: user._id,
    expiresAt: null
  });
  return token;
};

const ensureAccountToken = async (user) => {
  if (user.authToken) {
    const valid = await TokenSession.isValid(user.authToken);
    if (valid) return user.authToken;
  }
  return issueAccountToken(user);
};

const buildCredentialsPayload = async (req, user) => {
  const owner = user.parentUserId ? await User.findById(user.parentUserId) : user;
  if (!owner) {
    const err = new Error('Owner account not found');
    err.status = 404;
    throw err;
  }
  const token = await ensureAccountToken(owner);
  const clients = await WhatsAppClientModel.find(
    { userId: owner._id, isActive: true },
    { sort: { createdAt: -1 } }
  );
  const apiBaseUrl = getPublicApiBase(req);
  const source = user.source || '';
  const sourceClient = source
    ? clients.find((item) => item.source === source)
    : null;
  const primaryClient = sourceClient
    || clients.find((item) => item.status === 'connected')
    || clients[0]
    || null;
  const envLines = [
    `WHATSAPP_NODE_URL=${apiBaseUrl}`,
    `WHATSAPP_NODE_TOKEN=${token}`,
    primaryClient ? `WHATSAPP_NODE_CLIENT_ID=${primaryClient._id}` : 'WHATSAPP_NODE_CLIENT_ID=',
    source ? `WHATSAPP_NODE_SOURCE=${source}` : null
  ].filter(Boolean);

  return {
    account: {
      _id: user._id,
      name: user.name,
      email: user.email,
      source: source || null,
      parentUserId: user.parentUserId || null
    },
    owner: {
      _id: owner._id,
      name: owner.name,
      email: owner.email
    },
    token,
    apiBaseUrl,
    otpUrl: apiBaseUrl ? `${apiBaseUrl}/otp/send` : '',
    source: source || null,
    sharesOwnerWhatsApp: Boolean(user.parentUserId),
    clients: clients.map((item) => ({
      _id: item._id,
      name: item.name,
      clientId: item.clientId,
      source: item.source || null,
      status: item.status,
      phone: item.phone || null
    })),
    laravelEnv: envLines.join('\n')
  };
};

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
    for (const ownerId of ownerIds) {
      if (!ownerId) continue;
      sourcesByOwner[ownerId] = await UserSource.listByUser(ownerId);
    }
    for (const row of result) {
      const ownerId = row.parentUserId || row._id;
      const plan = plansById.get(row.planId);
      const ownerSources = sourcesByOwner[ownerId] || [];
      row.plan = plan || null;
      row.enabledSources = ownerSources
        .filter((item) => item.enabled)
        .map((item) => item.source);
      row.sourceCatalog = ownerSources.map((item) => item.source);
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

    const planId = req.body.planId ? String(req.body.planId) : '';
    if (!planId) {
      await User.setPlan(user._id, null, 'none');
      const updated = await User.findById(user._id);
      const sub = await getAccountSubscription(updated);
      return res.json({
        user: updated.toJSON(),
        subscription: serializeSubscription(sub, updated),
        message: 'Plan removed'
      });
    }

    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const refillBalance = req.body.refillBalance !== false;
    const sub = await assignPlanToUser(user, plan, { refillBalance });
    const updated = await User.findById(user._id);
    res.json({
      user: updated.toJSON(),
      subscription: serializeSubscription(sub, updated),
      message: user.parentUserId
        ? `Assigned ${plan.name} (${plan.messageQuota} messages). WhatsApp stays on the owner.`
        : `Assigned ${plan.name} (${plan.messageQuota} messages, ${plan.sourceLimit} sources)`
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
    const toRemove = [...new Set(
      (Array.isArray(req.body.remove) ? req.body.remove : [])
        .map((item) => normalizeMessageSource(item))
        .filter(Boolean)
    )];

    for (const name of toRemove) {
      const locked = await User.findOne({ parentUserId: ownerId, source: name });
      if (locked) {
        return res.status(400).json({
          error: `Cannot delete "${name}" while ${locked.email} is locked to it. Use Allow switch first.`
        });
      }
    }

    const limit = sub.plan?.sourceLimit || (sub.status === 'active' ? 1 : wanted.length);
    if (sub.status === 'active' && wanted.length > limit) {
      return res.status(400).json({
        error: `${sub.plan?.name || 'This'} plan allows ${limit} source(s). Disable one before enabling another.`
      });
    }

    if (toRemove.length) {
      await UserSource.remove(ownerId, toRemove);
    }
    const sources = await UserSource.setEnabledSources(ownerId, wanted.filter((name) => !toRemove.includes(name)));
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

// POST /api/admin/users/:id/sources — add one source to a main service (owner)
router.post('/users/:id/sources', [
  body('source').trim().notEmpty().withMessage('Source name is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ownerId = user.parentUserId || user._id;
    const owner = user.parentUserId ? await User.findById(user.parentUserId) : user;
    if (!owner) return res.status(404).json({ error: 'Main service not found' });
    if (owner.role === 'admin') {
      return res.status(400).json({ error: 'Cannot assign a source to an admin login.' });
    }

    const sourceName = normalizeMessageSource(req.body.source);
    if (!sourceName) {
      return res.status(400).json({ error: 'Source must be letters, numbers, dot, dash, or underscore' });
    }

    const sub = await getOwnerSubscription(ownerId);
    const existing = await UserSource.listByUser(ownerId);
    const enabled = existing.filter((item) => item.enabled).map((item) => item.source);
    const already = existing.find((item) => item.source === sourceName);

    if (already?.enabled) {
      return res.json({
        sources: existing,
        enabledSources: enabled,
        source: sourceName,
        message: `"${sourceName}" is already assigned to ${owner.name}`
      });
    }

    const nextEnabled = [...new Set([...enabled, sourceName])];
    const limit = sub.plan?.sourceLimit || (sub.status === 'active' ? 1 : nextEnabled.length);
    if (sub.status === 'active' && nextEnabled.length > limit) {
      return res.status(400).json({
        error: `${sub.plan?.name || 'This'} plan allows ${limit} source(s). Disable one before adding another.`
      });
    }

    await UserSource.upsert({ userId: ownerId, source: sourceName, enabled: true });
    const sources = await UserSource.listByUser(ownerId);
    const next = await getOwnerSubscription(ownerId);
    res.status(already ? 200 : 201).json({
      sources,
      enabledSources: next.enabledSources,
      subscription: serializeSubscription(next, owner),
      source: sourceName,
      ownerId: owner._id,
      message: `"${sourceName}" assigned to ${owner.name}`
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

// GET /api/admin/users/:id/clients — WhatsApp clients for this owner
router.get('/users/:id/clients', async (req, res) => {
  try {
    const owner = await resolveOwner(req.params.id);
    if (!owner) return res.status(404).json({ error: 'User not found' });

    const clients = await WhatsAppClientModel.find(
      { userId: owner._id, isActive: true },
      { sort: { createdAt: -1 } }
    );
    res.json({
      userId: owner._id,
      ownerName: owner.name,
      ownerEmail: owner.email,
      count: clients.length,
      clients
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/clients — create WhatsApp client on this owner
router.post('/users/:id/clients', [
  body('name').trim().notEmpty().withMessage('Client name is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const owner = await resolveOwner(req.params.id);
    const { client, qrShare, reused } = await createWhatsAppClientForOwner(req, owner, {
      name: req.body.name,
      phone: req.body.phone,
      source: req.body.source
    });
    res.status(reused ? 200 : 201).json({
      client,
      qrShare,
      message: reused
        ? `This number is already assigned to "${client.source}". Open Share QR and scan to reconnect.`
        : `WhatsApp number created and assigned to "${client.source}". Open Share QR and scan.`
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/admin/phone-numbers — all WhatsApp clients with owner
router.get('/phone-numbers', async (_req, res) => {
  try {
    const clients = await WhatsAppClientModel.findAllWithOwners({ isActive: true });
    res.json({
      count: clients.length,
      clients
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/phone-numbers — add a WhatsApp number and assign it to a source/client
router.post('/phone-numbers', [
  body('userId').trim().notEmpty().withMessage('Main service is required'),
  body('source').trim().notEmpty().withMessage('Source / client is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const owner = await resolveOwner(req.body.userId);
    if (!owner) return res.status(404).json({ error: 'User not found' });

    const sourceName = normalizeMessageSource(req.body.source);
    const { client, qrShare, reused } = await createWhatsAppClientForOwner(req, owner, {
      name: req.body.clientName || sourceName,
      phone: req.body.phone,
      source: sourceName
    });

    res.status(reused ? 200 : 201).json({
      user: owner.toJSON(),
      client,
      qrShare,
      message: reused
        ? `Number already assigned to "${client.source}". Scan the QR to connect it.`
        : `Number assigned to "${client.source}". Scan the QR to connect it.`
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/clients/:id/connect — start QR for any owner's client
router.post('/clients/:id/connect', async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      isActive: true
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    if (client.status === 'connected' && isClientConnected(client.clientId)) {
      return res.json({
        message: 'Client already connected',
        client,
        qrShare: buildQrSharePayload(req, client.clientId)
      });
    }

    await WhatsAppClientModel.findByIdAndUpdate(client._id, { status: 'initializing' });
    res.json({
      message: 'WhatsApp initialization started. Open Share QR and scan when ready.',
      clientId: client.clientId,
      qrShare: buildQrSharePayload(req, client.clientId)
    });

    (async () => {
      try {
        await createWhatsAppClient(client.clientId);
      } catch (err) {
        console.error(`Admin init error for ${client.clientId}:`, err);
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/clients/:id/qr-share-link — public scan page for this client
router.get('/clients/:id/qr-share-link', async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      isActive: true
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const qrShare = buildQrSharePayload(req, client.clientId);
    if (!qrShare) {
      return res.status(500).json({
        error: 'QR sharing is not configured. Set QR_SHARE_TOKEN in environment.'
      });
    }
    res.json({
      ...qrShare,
      status: client.status,
      qrCode: client.qrCode || null,
      name: client.name
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/:id/credentials — token + WhatsApp client IDs for other servers
router.get('/users/:id/credentials', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const credentials = await buildCredentialsPayload(req, user);
    res.json(credentials);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/credentials/regenerate — new token for this account
router.post('/users/:id/credentials/regenerate', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const owner = user.parentUserId ? await User.findById(user.parentUserId) : user;
    if (!owner) return res.status(404).json({ error: 'Owner account not found' });
    if (owner.authToken) {
      await TokenSession.revoke(owner.authToken);
    }
    await issueAccountToken(owner);
    const credentials = await buildCredentialsPayload(req, user);
    res.json({
      ...credentials,
      message: 'New owner token created. Update the other server with this token.'
    });
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
