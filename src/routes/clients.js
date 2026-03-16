const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { createWhatsAppClient, destroyClient, isClientConnected } = require('../services/whatsappManager');
const authMiddleware = require('../middleware/auth');

const withTimeout = (promise, ms, message) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
};

// GET /api/clients - list all clients for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const clients = await WhatsAppClientModel.find({ userId: req.user._id, isActive: true })
      .sort({ createdAt: -1 });
    res.json({ clients });
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

    res.status(201).json({ client });
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
        await createWhatsAppClient(client.clientId, { forceReauth: shouldForceReauth });
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
