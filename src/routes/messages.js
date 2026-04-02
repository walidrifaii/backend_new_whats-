const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { sendMessage } = require('../services/whatsappManager');
const { sendBalanceExhaustedEmail } = require('../services/balanceNotifier');
const authMiddleware = require('../middleware/auth');

const logBalanceEmailResult = (context, result, email) => {
  console.log(
    `[BALANCE_EMAIL] context=${context} ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${email || 'n/a'}`
  );
};

// POST /api/messages/send - Send a single message
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { clientId, phone, message, mediaUrl } = req.body;
    if (!clientId || !phone || (!message && !mediaUrl)) {
      return res.status(400).json({
        error: 'clientId and phone are required; provide message and/or mediaUrl'
      });
    }

    const balance = await User.getBalance(req.user._id);
    if (balance <= 0) {
      sendBalanceExhaustedEmail({
        userId: req.user._id,
        email: req.user.email,
        name: req.user.name
      })
        .then((result) => logBalanceEmailResult('single_send_blocked', result, req.user.email))
        .catch((err) => logBalanceEmailResult('single_send_blocked', { ok: false, reason: err.message }, req.user.email));
      return res.status(403).json({
        error: 'You need to charge balance in message.',
        balanceExhausted: true,
        currentBalance: 0
      });
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

    const sendOpts = mediaUrl && String(mediaUrl).trim() ? { mediaUrl: String(mediaUrl).trim() } : null;
    const result = await sendMessage(
      dbClient.clientId,
      phone,
      message != null ? String(message) : '',
      sendOpts
    );

    await User.decrementBalance(req.user._id, 1);
    const updatedBalance = await User.getBalance(req.user._id);
    if (updatedBalance <= 0) {
      sendBalanceExhaustedEmail({
        userId: req.user._id,
        email: req.user.email,
        name: req.user.name
      })
        .then((result) => logBalanceEmailResult('single_send_reached_zero', result, req.user.email))
        .catch((err) => logBalanceEmailResult('single_send_reached_zero', { ok: false, reason: err.message }, req.user.email));
    }

    const logText =
      [message, mediaUrl && `(media: ${mediaUrl})`].filter(Boolean).join(' ') || '(media only)';

    await MessageLog.create({
      userId: req.user._id,
      clientId: dbClient._id,
      phone,
      message: logText,
      direction: 'outgoing',
      status: 'sent',
      whatsappMessageId: result?.id?._serialized
    });

    res.json({
      message: 'Message sent',
      messageId: result?.id?._serialized,
      remainingBalance: updatedBalance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
