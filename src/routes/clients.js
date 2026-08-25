const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { createWhatsAppClient, destroyClient, isClientConnected } = require('../services/whatsappManager');
const authMiddleware = require('../middleware/auth');
const { buildQrSharePayload } = require('../utils/qrShare');
const { getOwnerUserId, isServiceAccount } = require('../utils/accountScope');
const { getOwnerSubscription } = require('../utils/subscription');
const App = require('../models/App');

const rejectServiceAccountWrite = (req, res) => {
  if (!isServiceAccount(req.user)) return false;
  res.status(403).json({
    error: 'Service logins cannot manage WhatsApp. Sign in with the owner account to connect the number.'
  });
  return true;
};

const withTimeout = (promise, ms, message) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
};

// GET /api/clients - list all clients for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const clients = await WhatsAppClientModel.find(
      { userId: getOwnerUserId(req.user), isActive: true },
      { sort: { createdAt: -1 } }
    );
    res.json({ clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/user/:userId - list all clients for a specific user
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const requestedUserId = String(req.params.userId || '').trim();
    if (!requestedUserId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const isAdmin = req.user?.isAdmin || req.user?.role === 'admin';
    if (!isAdmin && requestedUserId !== String(req.user._id)) {
      return res.status(403).json({ error: 'Access denied for this userId' });
    }

    const clients = await WhatsAppClientModel.find(
      { userId: requestedUserId, isActive: true },
      { sort: { createdAt: -1 } }
    );

    res.json({
      userId: requestedUserId,
      count: clients.length,
      clients
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients - client creates their own WhatsApp number, then scans QR
router.post('/', authMiddleware, [
  body('name').trim().notEmpty().withMessage('Number name is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (rejectServiceAccountWrite(req, res)) return;

  try {
    const ownerId = getOwnerUserId(req.user);
    const sub = await getOwnerSubscription(ownerId);
    const activeApps = await App.listForClient(ownerId, { activeOnly: true });
    const sourceLimit = Number(sub.sourceLimit || sub.plan?.sourceLimit || 0);
    if (sourceLimit > 0 && activeApps.length >= sourceLimit) {
      return res.status(403).json({
        error: `Your plan allows up to ${sourceLimit} WhatsApp number(s). Ask admin to upgrade the plan or remove an unused number.`
      });
    }

    const sessionId = `client_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
    const created = await WhatsAppClientModel.create({
      userId: ownerId,
      name: String(req.body.name || '').trim(),
      clientId: sessionId,
      sessionPath: `./sessions/${sessionId}`,
      status: 'disconnected'
    });

    const client = await WhatsAppClientModel.findByIdAndUpdate(
      created._id,
      { status: 'initializing' },
      { new: true }
    );

    res.status(201).json({
      client,
      message: 'WhatsApp number created. Scan the QR code to connect.'
    });

    (async () => {
      try {
        await createWhatsAppClient(sessionId);
      } catch (err) {
        console.error(`Client self-create init error for ${sessionId}:`, err);
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/connect - initialize WhatsApp connection
router.post('/:id/connect', authMiddleware, async (req, res) => {
  if (rejectServiceAccountWrite(req, res)) return;
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      userId: getOwnerUserId(req.user),
      isActive: true
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    if (client.status === 'connected' && isClientConnected(client.clientId)) {
      return res.json({ message: 'Client already connected', client });
    }

    const shouldForceReauth =
      req.query.reset === '1' || req.body?.forceReauth === true;

    if (isClientConnected(client.clientId) && !shouldForceReauth) {
      return res.json({
        message: 'Client is already initializing. Wait for QR/ready event.',
        clientId: client.clientId
      });
    }

    // Respond immediately to avoid request hanging in deployments.
    await WhatsAppClientModel.findByIdAndUpdate(client._id, { status: 'initializing' });
    res.json({
      message: shouldForceReauth
        ? 'WhatsApp re-auth started. Scan new QR code when ready.'
        : 'WhatsApp initialization started. Scan QR code when ready.',
      clientId: client.clientId
    });

    // Run teardown + initialization in background.
    (async () => {
      if (shouldForceReauth) {
        try {
          await withTimeout(
            destroyClient(client.clientId),
            12000,
            `Destroy client timeout for ${client.clientId}`
          );
        } catch (destroyErr) {
          console.warn(`Destroy warning for ${client.clientId}:`, destroyErr.message);
        }
      }

      try {
      await   createWhatsAppClient(client.clientId);
      } catch (err) {
        console.error(`Init error for ${client.clientId}:`, err);
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/disconnect
router.post('/:id/disconnect', authMiddleware, async (req, res) => {
  if (rejectServiceAccountWrite(req, res)) return;
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      userId: getOwnerUserId(req.user)
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    await destroyClient(client.clientId, { skipDisconnectEmail: true });
    res.json({ message: 'Client disconnected', client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id - get single client status
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      userId: getOwnerUserId(req.user)
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    res.json({ client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/qr-share-link - get QR-only public links for one client
router.get('/:id/qr-share-link', authMiddleware, async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      userId: getOwnerUserId(req.user),
      isActive: true
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const qrShare = buildQrSharePayload(req, client.clientId);
    if (!qrShare) {
      return res.status(500).json({
        error: 'QR sharing is not configured. Set QR_SHARE_TOKEN in environment.'
      });
    }
    res.json(qrShare);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id — users cannot remove pool numbers
router.delete('/:id', authMiddleware, async (req, res) => {
  if (rejectServiceAccountWrite(req, res)) return;
  return res.status(403).json({
    error: 'Only the super admin can remove WhatsApp numbers.'
  });
});

module.exports = router;
