const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { createWhatsAppClient, destroyClient, isClientConnected } = require('../services/whatsappManager');
const authMiddleware = require('../middleware/auth');
const { buildClientQrToken } = require('../utils/qrShare');

const withTimeout = (promise, ms, message) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
};

const buildQrSharePayload = (req, clientId) => {
  const token = buildClientQrToken(clientId);
  if (!token) return null;

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return {
    clientId,
    pageUrl: `${baseUrl}/public/qr/${clientId}?token=${token}`,
    imageUrl: `${baseUrl}/public/qr/${clientId}.png?token=${token}`
  };
};

// GET /api/clients - list all clients for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const clients = await WhatsAppClientModel.find(
      { userId: req.user._id, isActive: true },
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

// POST /api/clients - create new client
router.post('/', authMiddleware, [
  body('name').trim().notEmpty().withMessage('Client name is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name } = req.body;
    const clientId = `client_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

    const client = await WhatsAppClientModel.create({
      userId: req.user._id,
      name,
      clientId,
      sessionPath: `./sessions/${clientId}`,
      status: 'disconnected'
    });

    res.status(201).json({
      client,
      qrShare: buildQrSharePayload(req, client.clientId)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/connect - initialize WhatsApp connection
router.post('/:id/connect', authMiddleware, async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      userId: req.user._id,
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
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    await destroyClient(client.clientId);
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
      userId: req.user._id
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
      userId: req.user._id,
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

// DELETE /api/clients/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const client = await WhatsAppClientModel.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    await destroyClient(client.clientId);
    await WhatsAppClientModel.findByIdAndUpdate(client._id, { isActive: false });
    res.json({ message: 'Client deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
