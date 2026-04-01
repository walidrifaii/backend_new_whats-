const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { sendMessage } = require('../services/whatsappManager');
const { sendBalanceExhaustedEmail } = require('../services/balanceNotifier');
const authMiddleware = require('../middleware/auth');

<<<<<<< HEAD
const logBalanceEmailResult = (context, result, email) => {
  console.log(
    `[BALANCE_EMAIL] context=${context} ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${email || 'n/a'}`
  );
};

// POST /api/messages/send - Send a single message
=======
const generateOtpCode = (length = 6) => {
  const safeLength = Number.isInteger(length) && length >= 4 && length <= 8 ? length : 6;
  let code = '';
  for (let i = 0; i < safeLength; i += 1) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
};

// POST /api/messages/send - Send a single message (optional image via public URL)
>>>>>>> 4301074 ( upload image)
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { clientId, phone, message, caption, imageUrl, mediaUrl } = req.body;
    const textBody = String(message || '').trim();
    const textCaption = String(caption || '').trim();
    const img = String(imageUrl || mediaUrl || '').trim();
    const combinedText = textCaption || textBody;

    if (!clientId || !phone) {
      return res.status(400).json({ error: 'clientId and phone are required' });
    }
    if (!combinedText && !img) {
      return res.status(400).json({
        error: 'Provide a message, caption, or image URL (or any combination)'
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

    const result = await sendMessage(
      dbClient.clientId,
      phone,
      combinedText,
      img || null
    );

    const logText = img
      ? `[image] ${combinedText || '(no caption)'}`.trim()
      : combinedText;

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

// POST /api/messages/send-otp - Send OTP using user's default connected client
router.post('/send-otp', authMiddleware, async (req, res) => {
  try {
    const { phone, otp, otpLength, appName, expiryMinutes } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    const dbClient = await WhatsAppClientModel.findOne({
      userId: req.user._id,
      isActive: true,
      status: 'connected'
    });

    if (!dbClient) {
      return res.status(400).json({
        error: 'No connected WhatsApp client found. Connect a number first.'
      });
    }

    const otpCode = String(otp || generateOtpCode(Number(otpLength)));
    const safeExpiryMinutes = Number.isFinite(Number(expiryMinutes))
      ? Math.max(1, Math.min(60, Number(expiryMinutes)))
      : 10;
    const safeAppName = String(appName || 'Your App').trim() || 'Your App';
    const otpMessage = `${safeAppName} OTP: ${otpCode}. Expires in ${safeExpiryMinutes} minutes.`;

    const result = await sendMessage(dbClient.clientId, phone, otpMessage);

    await MessageLog.create({
      userId: req.user._id,
      clientId: dbClient._id,
      phone,
      message: otpMessage,
      direction: 'outgoing',
      status: 'sent',
      whatsappMessageId: result?.id?._serialized
    });

    res.json({
      message: 'OTP sent',
      otp: otpCode,
      messageId: result?.id?._serialized,
      clientId: dbClient._id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
