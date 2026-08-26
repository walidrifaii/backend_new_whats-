const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const UserSource = require('../models/UserSource');
const Plan = require('../models/Plan');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const TokenSession = require('../models/TokenSession');
const { query } = require('../db/mysql');
const { CLIENT, OTP_NUMBER, APP } = require('../db/tables');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { createWhatsAppClient, isClientConnected, destroyClient } = require('../services/whatsappManager');
const { getOwnerSubscription, getAccountSubscription, serializeSubscription, assignPlanToUser, assignPlanToNumber } = require('../utils/subscription');
const { normalizeMessageSource } = require('../utils/messageSource');
const { buildQrSharePayload } = require('../utils/qrShare');

const resolveOwner = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return null;
  if (user.parentUserId) return User.findById(user.parentUserId);
  return user;
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
  const primaryClient = clients.find((item) => item.status === 'connected') || clients[0] || null;
  const source = user.source || '';
  const services = await UserSource.list(owner._id);
  const envFor = (svc) => {
    const numberId = svc?.phoneNumberId || primaryClient?._id || '';
    return [
      `WHATSAPP_NODE_URL=${apiBaseUrl}`,
      `WHATSAPP_NODE_TOKEN=${token}`,
      `WHATSAPP_NODE_CLIENT_ID=${numberId}`,
      `WHATSAPP_NODE_SOURCE=${svc?.name || 'ehkini'}`
    ].join('\n');
  };
  const envLines = [
    `WHATSAPP_NODE_URL=${apiBaseUrl}`,
    `WHATSAPP_NODE_TOKEN=${token}`,
    primaryClient ? `WHATSAPP_NODE_CLIENT_ID=${primaryClient._id}` : 'WHATSAPP_NODE_CLIENT_ID=',
    source ? `WHATSAPP_NODE_SOURCE=${source}` : 'WHATSAPP_NODE_SOURCE=ehkini'
  ].filter(Boolean);
  const laravelEnv = services.length
    ? services.map((svc) => `# ${svc.name}\n${envFor(svc)}`).join('\n\n')
    : envLines.join('\n');

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
    sourceOptional: true,
    sharesOwnerWhatsApp: Boolean(user.parentUserId),
    services: services.map((svc) => ({
      name: svc.name,
      enabled: svc.enabled,
      phoneNumberId: svc.phoneNumberId,
      phoneNumber: svc.phoneNumber,
      laravelEnv: envFor(svc)
    })),
    clients: clients.map((item) => ({
      _id: item._id,
      name: item.name,
      clientId: item.clientId,
      status: item.status,
      phone: item.phone || null
    })),
    laravelEnv
  };
};

const serializeNumber = async (client, assignedUsers = null) => {
  const plan = client.planId ? await Plan.findById(client.planId) : null;
  const users = assignedUsers || await WhatsAppClientModel.listAssignedUsers(client._id);
  return {
    _id: client._id,
    name: client.name,
    phone: client.phone || null,
    clientId: client.clientId,
    status: client.status,
    qrCode: client.qrCode || null,
    isActive: client.isActive,
    userIds: users.map((item) => item._id),
    planId: client.planId || null,
    planStatus: client.planStatus || 'none',
    messageBalance: client.messageBalance ?? 0,
    lastConnected: client.lastConnected || null,
    createdAt: client.createdAt,
    plan: plan
      ? {
          _id: plan._id,
          name: plan.name,
          slug: plan.slug,
          messageQuota: plan.messageQuota,
          sourceLimit: plan.sourceLimit
        }
      : null,
    assignedUsers: users
  };
};

router.use(authMiddleware, adminMiddleware);

// GET /api/admin/numbers — WhatsApp number pool
router.get('/numbers', async (_req, res) => {
  try {
    const clients = await WhatsAppClientModel.find({ isActive: true }, { sort: { createdAt: -1 } });
    const assignedByNumber = await WhatsAppClientModel.listAssignedUsersByNumberIds(
      clients.map((item) => item._id)
    );
    const numbers = [];
    for (const client of clients) {
      numbers.push(await serializeNumber(client, assignedByNumber[client._id] || []));
    }
    const users = await User.findAll();
    const assignableUsers = users
      .filter((u) => !u.parentUserId && u.role !== 'admin')
      .map((u) => ({ _id: u._id, name: u.name, email: u.email }));
    const plans = await Plan.findAll({ activeOnly: true });
    res.json({ numbers, users: assignableUsers, plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/numbers/:id — one number with assignable users and plans
router.get('/numbers/:id', async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({ _id: req.params.id, isActive: true });
    if (!client) return res.status(404).json({ error: 'Number not found' });
    const users = await User.findAll();
    const assignableUsers = users
      .filter((u) => !u.parentUserId && u.role !== 'admin')
      .map((u) => ({ _id: u._id, name: u.name, email: u.email }));
    const plans = await Plan.findAll({ activeOnly: true });
    res.json({
      number: await serializeNumber(client),
      users: assignableUsers,
      plans
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/numbers — create WhatsApp in the pool (no user)
router.post('/numbers', [
  body('name').trim().notEmpty().withMessage('Number name is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const clientId = `client_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
    const createdClient = await WhatsAppClientModel.create({
      userId: null,
      name: req.body.name,
      clientId,
      sessionPath: `./sessions/${clientId}`,
      status: 'disconnected'
    });

    const client = await WhatsAppClientModel.findByIdAndUpdate(
      createdClient._id,
      { status: 'initializing' },
      { new: true }
    );

    res.status(201).json({
      number: await serializeNumber(client),
      qrShare: buildQrSharePayload(req, client.clientId),
      message: 'Number created with no user. Open Share QR and scan, then assign a plan and users.'
    });

    (async () => {
      try {
        await createWhatsAppClient(client.clientId);
      } catch (err) {
        console.error(`Admin pool init error for ${client.clientId}:`, err);
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/numbers/:id/plan — Mini / Medium / Max on the number
router.patch('/numbers/:id/plan', async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({ _id: req.params.id, isActive: true });
    if (!client) return res.status(404).json({ error: 'Number not found' });

    const planId = req.body.planId ? String(req.body.planId) : '';
    if (!planId) {
      const updated = await assignPlanToNumber(client, null, { refillBalance: false });
      return res.json({
        number: await serializeNumber(updated),
        message: 'Plan removed from this number'
      });
    }

    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const refillBalance = req.body.refillBalance !== false;
    const updated = await assignPlanToNumber(client, plan, { refillBalance });
    res.json({
      number: await serializeNumber(updated),
      message: `Assigned ${plan.name} (${plan.messageQuota} messages) to this number`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/numbers/:id/assign — add, remove, or clear users on a number
router.patch('/numbers/:id/assign', async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({ _id: req.params.id, isActive: true });
    if (!client) return res.status(404).json({ error: 'Number not found' });

    const action = String(req.body.action || '').trim().toLowerCase();
    const rawUserId = req.body.userId;
    const nextUserId = rawUserId == null || rawUserId === '' ? null : String(rawUserId);

    if (action === 'remove') {
      if (!nextUserId) return res.status(400).json({ error: 'userId is required to remove a user' });
      const updated = await WhatsAppClientModel.removeUser(client._id, nextUserId);
      return res.json({
        number: await serializeNumber(updated),
        message: 'User removed from this number'
      });
    }

    if (!nextUserId) {
      const updated = await WhatsAppClientModel.clearUsers(client._id);
      return res.json({
        number: await serializeNumber(updated),
        message: 'Number returned to the pool'
      });
    }

    const user = await User.findById(nextUserId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.parentUserId) {
      return res.status(400).json({ error: 'Assign numbers to the owner account, not a service login.' });
    }

    const updated = await WhatsAppClientModel.addUser(client._id, nextUserId);
    res.json({
      number: await serializeNumber(updated),
        message: 'OTP number assigned to this client'
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/numbers/:id/balance — set or add messages on the number
router.patch('/numbers/:id/balance', [
  body('balance').optional().isInt({ min: 0 }),
  body('amount').optional().isInt({ min: 1 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const client = await WhatsAppClientModel.findOne({ _id: req.params.id, isActive: true });
    if (!client) return res.status(404).json({ error: 'Number not found' });

    let nextBalance = client.messageBalance ?? 0;
    if (req.body.balance !== undefined) {
      nextBalance = parseInt(req.body.balance, 10);
    } else if (req.body.amount !== undefined) {
      nextBalance = nextBalance + parseInt(req.body.amount, 10);
    } else {
      return res.status(400).json({ error: 'Provide balance or amount' });
    }

    const updated = await WhatsAppClientModel.updateBalance(client._id, nextBalance);
    const App = require('../models/App');
    await App.setBalanceForOtpNumber(client._id, nextBalance);
    res.json({
      number: await serializeNumber(updated),
      message: `Number balance set to ${updated.messageBalance}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/numbers/:id — soft-delete phone number from the pool
router.delete('/numbers/:id', async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({ _id: req.params.id, isActive: true });
    if (!client) return res.status(404).json({ error: 'Number not found' });

    if (client.clientId) {
      try {
        await destroyClient(client.clientId);
      } catch (err) {
        console.warn(`Destroy session for ${client.clientId}:`, err.message);
      }
    }

    await WhatsAppClientModel.softDelete(client._id);
    res.json({ message: 'Phone number deleted', id: client._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users — create an owner account (optional OTP numberIds → App rows)
router.post('/users', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const email = String(req.body.email).trim().toLowerCase();
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const user = await User.create({
      name: req.body.name,
      email,
      password: req.body.password,
      role: 'user'
    });

    const rawIds = Array.isArray(req.body.numberIds)
      ? req.body.numberIds
      : (req.body.numberId ? [req.body.numberId] : []);
    const numberIds = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];
    const assigned = [];
    for (const numberId of numberIds) {
      const number = await WhatsAppClientModel.findOne({ _id: numberId, isActive: true });
      if (!number) {
        return res.status(404).json({
          error: `OTP number not found: ${numberId}`,
          user: user.toJSON()
        });
      }
      await WhatsAppClientModel.addUser(number._id, user._id);
      assigned.push({
        _id: number._id,
        name: number.name,
        phone: number.phone,
        status: number.status
      });
    }

    const message = assigned.length
      ? `Client created and linked to ${assigned.length} WhatsApp number${assigned.length === 1 ? '' : 's'}.`
      : 'Client created. Assign any OTP numbers from Numbers or Manage.';

    res.status(201).json({
      user: user.toJSON(),
      assignedNumbers: assigned,
      message
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users — list all users with message stats
router.get('/users', async (req, res) => {
  try {
    const users = await User.findAll();

    const stats = await query(`
      SELECT client_id AS user_id,
        COUNT(*) AS total_messages,
        SUM(CASE WHEN status = 'sent' AND direction = 'outgoing' THEN 1 ELSE 0 END) AS sent_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM message_logs
      GROUP BY client_id
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
      SELECT client_id AS user_id,
        COALESCE(NULLIF(source, ''), '_untagged') AS source,
        COUNT(*) AS total_messages,
        SUM(CASE WHEN status = 'sent' AND direction = 'outgoing' THEN 1 ELSE 0 END) AS sent_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM message_logs
      GROUP BY client_id, COALESCE(NULLIF(source, ''), '_untagged')
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
      SELECT a.client_id AS user_id, COUNT(DISTINCT a.OTP_NUMBER_id) AS count
      FROM ${APP} a
      INNER JOIN ${OTP_NUMBER} pn ON pn.id = a.OTP_NUMBER_id
      WHERE pn.is_active = 1 AND a.\`Active\` = 1
      GROUP BY a.client_id
    `);
    const clientMap = {};
    for (const c of clientCounts) {
      clientMap[c.user_id] = c.count;
    }

    const clientPhones = await query(`
      SELECT a.client_id AS user_id, pn.number AS phone, pn.title AS name, pn.status, pn.plan_id, pn.plan_status, pn.message_balance, pn.id
      FROM ${APP} a
      INNER JOIN ${OTP_NUMBER} pn ON pn.id = a.OTP_NUMBER_id
      WHERE pn.is_active = 1 AND a.\`Active\` = 1
      ORDER BY (pn.status = 'connected') DESC, pn.created_at DESC
    `);
    const phonesMap = {};
    const numbersMap = {};
    for (const row of clientPhones) {
      const ownerId = String(row.user_id);
      if (!phonesMap[ownerId]) phonesMap[ownerId] = [];
      if (!numbersMap[ownerId]) numbersMap[ownerId] = [];
      if (!numbersMap[ownerId].some((item) => item._id === row.id)) {
        numbersMap[ownerId].push({
          _id: row.id,
          phone: row.phone || '',
          name: row.name || '',
          status: row.status || '',
          planId: row.plan_id || null,
          planStatus: row.plan_status || 'none',
          messageBalance: row.message_balance ?? 0
        });
      }
      const phone = String(row.phone || '').trim();
      if (!phone || phonesMap[ownerId].some((item) => item.phone === phone)) continue;
      phonesMap[ownerId].push({
        phone,
        name: row.name || '',
        status: row.status || ''
      });
    }

    const result = users.map(u => {
      const safe = u.toJSON();
      const ownerId = u.parentUserId || u._id;
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
      safe.phones = phonesMap[ownerId] || [];
      safe.assignedNumbers = numbersMap[ownerId] || [];
      safe.messageBalance = (numbersMap[ownerId] || []).reduce(
        (sum, item) => sum + (Number(item.messageBalance) || 0),
        0
      );
      return safe;
    });

    const plans = await Plan.findAll();
    const plansById = new Map(plans.map((p) => [p._id, p]));
    for (const row of result) {
      const ownerId = row.parentUserId || row._id;
      const plan = plansById.get(row.planId);
      const assigned = numbersMap[ownerId] || [];
      const numberPlan = assigned
        .map((item) => plansById.get(item.planId))
        .find(Boolean) || null;
      row.plan = numberPlan || plan || null;
      row.sourceCatalog = [];
      row.enabledSources = [];
    }

    const catalogMap = await UserSource.listForUsers(result.map((row) => row.parentUserId || row._id));
    const switchByOwner = {};
    for (const row of result) {
      if (!row.parentUserId) switchByOwner[row._id] = Boolean(row.allowSourceSwitch);
    }
    for (const row of result) {
      const ownerId = row.parentUserId || row._id;
      row.sourceCatalog = catalogMap[ownerId] || [];
      row.enabledSources = row.sourceCatalog.filter((item) => item.enabled).map((item) => item.name);
      if (row.parentUserId) row.allowSourceSwitch = Boolean(switchByOwner[row.parentUserId]);
    }

    res.json({ users: result, plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/:id — single user details (numbers + projects)
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ownerId = user.parentUserId || user._id;
    const owner = user.parentUserId ? await User.findById(ownerId) : user;
    const safe = user.toJSON();

    const assignedRows = await query(`
      SELECT pn.id, pn.number AS phone, pn.title AS name, pn.status, pn.plan_id, pn.plan_status, pn.message_balance
      FROM ${APP} a
      INNER JOIN ${OTP_NUMBER} pn ON pn.id = a.OTP_NUMBER_id
      WHERE a.client_id = ? AND pn.is_active = 1 AND a.\`Active\` = 1
      ORDER BY (pn.status = 'connected') DESC, pn.created_at DESC
    `, [ownerId]);

    const assignedNumbers = [];
    for (const row of assignedRows) {
      if (assignedNumbers.some((item) => item._id === row.id)) continue;
      assignedNumbers.push({
        _id: row.id,
        phone: row.phone || '',
        name: row.name || '',
        status: row.status || '',
        planId: row.plan_id || null,
        planStatus: row.plan_status || 'none',
        messageBalance: row.message_balance ?? 0
      });
    }

    const catalogMap = await UserSource.listForUsers([ownerId]);
    safe.assignedNumbers = assignedNumbers;
    safe.phones = assignedNumbers.map((item) => ({
      phone: item.phone,
      name: item.name,
      status: item.status
    }));
    safe.messageBalance = assignedNumbers.reduce(
      (sum, item) => sum + (Number(item.messageBalance) || 0),
      0
    );
    safe.sourceCatalog = catalogMap[ownerId] || [];
    safe.enabledSources = safe.sourceCatalog.filter((item) => item.enabled).map((item) => item.name);
    safe.allowSourceSwitch = Boolean(owner?.allowSourceSwitch ?? user.allowSourceSwitch);

    res.json({ user: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id — update name / email
router.patch('/users/:id', [
  body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
  body('email').optional().trim().isEmail().withMessage('Valid email is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    if (req.body.name === undefined && req.body.email === undefined) {
      return res.status(400).json({ error: 'Provide name and/or email' });
    }
    const updated = await User.updateProfile(req.params.id, {
      name: req.body.name,
      email: req.body.email
    });
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json({ user: updated.toJSON(), message: 'Client updated' });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
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
    await query(`UPDATE ${CLIENT} SET is_active = ? WHERE id = ?`, [newStatus, req.params.id]);
    const updated = await User.findById(req.params.id);
    res.json({ user: updated.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id — soft-delete client (and stats sub-accounts if owner)
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Client not found' });
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Cannot delete an admin account' });
    }
    if (!user.isActive) {
      return res.json({ message: 'Client already deleted', id: user._id });
    }

    const stamp = Date.now();
    const isOwner = !user.parentUserId;
    const toDelete = [user];

    if (isOwner) {
      await query(`UPDATE ${APP} SET \`Active\` = 0 WHERE client_id = ?`, [String(user._id)]);
      const children = await User.findByParentUserId(user._id);
      toDelete.push(...children);
    }

    for (const target of toDelete) {
      const deletedEmail = `deleted.${stamp}.${target.email}`.slice(0, 190);
      await query(
        `UPDATE ${CLIENT}
         SET is_active = 0, \`current_App_id\` = NULL, email = ?
         WHERE id = ?`,
        [deletedEmail, String(target._id)]
      );
      try {
        await TokenSession.revokeOwner('user', target._id);
        await TokenSession.revokeOwner('client', target._id);
      } catch (_) {
        /* optional */
      }
    }

    res.json({ message: 'Client deleted', id: user._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users/:id/service-accounts', async (req, res) => {
  try {
    const parent = await User.findById(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Owner account not found' });
    const ownerId = parent.parentUserId || parent._id;
    const accounts = await User.findByParentUserId(ownerId);
    res.json({ accounts: accounts.map((item) => item.toJSON()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/service-accounts — create a stats-login sub-account on this WhatsApp owner
router.post('/users/:id/service-accounts', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('source').optional({ checkFalsy: true }).trim(),
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
      message: 'Stats login created. They sign in at /stats-login and can switch this client’s services.'
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

// PATCH /api/admin/users/:id/source-lock
// null source = this email can switch; set source to lock this login to one Laravel app tag
router.patch('/users/:id/source-lock', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const raw = req.body.source;
    const lockTo = raw == null || raw === '' ? null : normalizeMessageSource(raw);
    if (raw && !lockTo) {
      return res.status(400).json({ error: 'Invalid source name' });
    }
    if (!user.parentUserId && lockTo) {
      return res.status(400).json({
        error: 'Do not lock the owner login. The owner already switches Shop/CRM in the dashboard.'
      });
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
    res.json({
      user: updated.toJSON(),
      message: lockTo
        ? `This login is locked to ${lockTo} and cannot switch.`
        : 'Source lock removed. This login can send without a locked source.'
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

const bindNumberToOwner = async (ownerId, phoneNumberId) => {
  if (!phoneNumberId) return null;
  const number = await WhatsAppClientModel.findOne({ _id: String(phoneNumberId), isActive: true });
  if (!number) {
    const err = new Error('Phone number not found');
    err.status = 404;
    throw err;
  }
  await WhatsAppClientModel.addUser(number._id, ownerId);
  return number;
};

const ownerSourcesPayload = async (user) => {
  const sources = await UserSource.list(user._id);
  const fresh = await User.findById(user._id);
  return {
    user: {
      ...fresh.toJSON(),
      sourceCatalog: sources,
      enabledSources: sources.filter((item) => item.enabled).map((item) => item.name),
      allowSourceSwitch: Boolean(fresh.allowSourceSwitch)
    }
  };
};

// PATCH /api/admin/users/:id/source-switch — super admin allows the owner to switch services
router.patch('/users/:id/source-switch', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.parentUserId) {
      return res.status(400).json({ error: 'Set source switch on the owner account, not a service login.' });
    }
    const allow = Boolean(req.body.allow);
    await User.setAllowSourceSwitch(user._id, allow);
    const payload = await ownerSourcesPayload(user);
    res.json({
      ...payload,
      message: allow
        ? 'Client can switch between allowed services.'
        : 'Client cannot switch services.'
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/sources — add a named service and attach a number
router.post('/users/:id/sources', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ownerId = user.parentUserId || user._id;
    const enabled = req.body.enabled !== false && req.body.enabled !== 0;
    const phoneNumberId = req.body.phoneNumberId || req.body.clientId || null;
    if (!phoneNumberId) {
      return res.status(400).json({ error: 'Pick a phone number for this service.' });
    }
    await bindNumberToOwner(ownerId, phoneNumberId);
    await UserSource.upsert(ownerId, req.body.source, { enabled, phoneNumberId });
    const owner = await User.findById(ownerId);
    const apps = await require('../models/App').listForClient(ownerId, { activeOnly: true });
    if (apps.length >= 2) {
      await User.setAllowSourceSwitch(ownerId, true);
    }
    const payload = await ownerSourcesPayload(owner);
    res.status(201).json({
      ...payload,
      message: `Added project ${normalizeMessageSource(req.body.source)}`
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/sources — allow/block or change number
router.patch('/users/:id/sources', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ownerId = user.parentUserId || user._id;
    const name = normalizeMessageSource(req.body.source);
    if (!name) return res.status(400).json({ error: 'Service name is required' });

    if (req.body.phoneNumberId !== undefined || req.body.clientId !== undefined) {
      const phoneNumberId = req.body.phoneNumberId || req.body.clientId || null;
      if (phoneNumberId) await bindNumberToOwner(ownerId, phoneNumberId);
      await UserSource.setPhoneNumber(ownerId, name, phoneNumberId);
    }
    if (req.body.enabled !== undefined) {
      await UserSource.setEnabled(ownerId, name, Boolean(req.body.enabled));
    }
    const owner = await User.findById(ownerId);
    const payload = await ownerSourcesPayload(owner);
    const service = (payload.user.sourceCatalog || []).find((item) => item.name === name);
    res.json({
      ...payload,
      message: req.body.enabled === false
        ? `${name} is not allowed.`
        : req.body.enabled
          ? `${name} is allowed.`
          : service?.phoneNumber
            ? `${name} now uses ${service.phoneNumber.phone || service.phoneNumber.name}.`
            : `${name} updated.`
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id/sources/:source
router.delete('/users/:id/sources/:source', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ownerId = user.parentUserId || user._id;
    await UserSource.remove(ownerId, req.params.source);
    const owner = await User.findById(ownerId);
    const payload = await ownerSourcesPayload(owner);
    res.json({ ...payload, message: `Removed source ${req.params.source}` });
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
    if (!owner) return res.status(404).json({ error: 'User not found' });
    if (owner.role === 'admin') {
      return res.status(400).json({ error: 'Cannot create a WhatsApp client on an admin login.' });
    }

    const clientId = `client_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
    const createdClient = await WhatsAppClientModel.create({
      name: req.body.name,
      clientId,
      sessionPath: `./sessions/${clientId}`,
      status: 'disconnected',
      userId: owner._id
    });

    const client = await WhatsAppClientModel.findByIdAndUpdate(
      createdClient._id,
      { status: 'initializing' },
      { new: true }
    );

    res.status(201).json({
      client,
      qrShare: buildQrSharePayload(req, client.clientId),
      message: 'WhatsApp client created. Open Share QR and scan when the code appears.'
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
    const [userCount] = await query(`SELECT COUNT(*) AS count FROM ${CLIENT}`);
    const [activeUsers] = await query(`SELECT COUNT(*) AS count FROM ${CLIENT} WHERE is_active = 1`);
    const [clientCount] = await query(`SELECT COUNT(*) AS count FROM ${OTP_NUMBER} WHERE is_active = 1`);
    const [connectedClients] = await query(`SELECT COUNT(*) AS count FROM ${OTP_NUMBER} WHERE status = 'connected' AND is_active = 1`);
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
