const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { createWhatsAppClient, destroyClient, isClientConnected } = require('../services/whatsappManager');
const authMiddleware = require('../middleware/auth');
const { buildQrSharePayload } = require('../utils/qrShare');
const { getOwnerUserId, isServiceAccount } = require('../utils/accountScope');

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

// POST /api/clients - users cannot create WhatsApp; admin assigns from the pool
router.post('/', authMiddleware, [
  body('name').trim().notEmpty().withMessage('Client name is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (rejectServiceAccountWrite(req, res)) return;

  return res.status(403).json({
    error: 'Only the super admin can add WhatsApp numbers. Ask admin to assign a number to your account.'
  });
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
