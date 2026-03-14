const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { sendMessage } = require('../services/whatsappManager');
const authMiddleware = require('../middleware/auth');

// POST /api/messages/send - Send a single message
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { clientId, phone, message } = req.body;
    if (!clientId || !phone || !message) {
      return res.status(400).json({ error: 'clientId, phone, and message are required' });
    }

    const dbClient = await WhatsAppClientModel.findOne({
      _id: clientId,
      userId: req.user._id,
      isActive: true
    });
    if (!dbClient) return res.status(404).json({ error: 'Client not found' });
    if (dbClient.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp client is not connected' });
    }

    const result = await sendMessage(dbClient.clientId, phone, message);

    await MessageLog.create({
      userId: req.user._id,
      clientId: dbClient._id,
      phone,
      message,
      direction: 'outgoing',
      status: 'sent',
      whatsappMessageId: result?.id?._serialized
    });

    res.json({ message: 'Message sent', messageId: result?.id?._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
