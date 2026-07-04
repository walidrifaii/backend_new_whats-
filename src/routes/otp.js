const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const {
  sendMessage,
  isClientConnected,
  waitForClientReady
} = require('../services/whatsappManager');
const { normalizePhone } = require('../utils/helpers');
const serviceAuthMiddleware = require('../middleware/serviceAuth');

const getOtpExpiresMinutes = () => {
  const n = parseInt(process.env.OTP_EXPIRES_MINUTES || '5', 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

const buildOtpMessage = (code) => {
  const template = String(
    process.env.OTP_MESSAGE_TEMPLATE ||
      'Your verification code is: {code}. Valid for {minutes} minutes. Do not share this code.'
  );
  return template
    .replace(/\{code\}/g, String(code))
    .replace(/\{minutes\}/g, String(getOtpExpiresMinutes()));
};

const resolveOtpClient = async (clientIdParam) => {
  const explicit = String(clientIdParam || process.env.OTP_DEFAULT_CLIENT_ID || '').trim();
  if (explicit) {
    const bySession = await WhatsAppClientModel.findOne({
      clientId: explicit,
      isActive: true,
      status: 'connected'
    });
    if (bySession) return bySession;

    const byDbId = await WhatsAppClientModel.findOne({
      _id: explicit,
      isActive: true,
      status: 'connected'
    });
    if (byDbId) return byDbId;
    return null;
  }

  const connected = await WhatsAppClientModel.find({ isActive: true, status: 'connected' });
  return connected[0] || null;
};

const ensureClientReadyForSend = async (sessionClientId) => {
  if (!isClientConnected(sessionClientId)) {
    console.log(`⏳ OTP: waiting for WhatsApp client ${sessionClientId} to come online...`);
  }
  await waitForClientReady(sessionClientId);
};

/**
 * POST /api/otp/send
 * Server-to-server OTP delivery via WhatsApp.
 *
 * Body: { phone, code, clientId?, message? }
 * Auth: X-Service-Key or Bearer OTP_SERVICE_SECRET
 */
router.post(
  '/send',
  serviceAuthMiddleware,
  [
    body('phone').trim().notEmpty().withMessage('phone is required'),
    body('code').trim().notEmpty().withMessage('code is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }

    try {
      const phone = normalizePhone(req.body.phone).replace('@c.us', '');
      const code = String(req.body.code).trim();
      const dbClient = await resolveOtpClient(req.body.clientId);

      if (!dbClient) {
        return res.status(503).json({
          ok: false,
          error:
            'No connected WhatsApp client available for OTP. Connect a client or set OTP_DEFAULT_CLIENT_ID.'
        });
      }

      const sessionClientId = dbClient.clientId;
      await ensureClientReadyForSend(sessionClientId);

      const text =
        req.body.message != null && String(req.body.message).trim()
          ? String(req.body.message).trim()
          : buildOtpMessage(code);

      const result = await sendMessage(sessionClientId, phone, text);
      const messageId = result?.id?._serialized || null;

      await MessageLog.create({
        userId: dbClient.userId,
        clientId: dbClient._id,
        phone,
        message: text,
        direction: 'outgoing',
        status: 'sent',
        whatsappMessageId: messageId
      });

      console.log(`✅ OTP sent to ${phone} via ${sessionClientId}`);

      return res.json({
        ok: true,
        message: 'OTP sent.',
        channel: 'whatsapp_node',
        expires_in: getOtpExpiresMinutes() * 60,
        messageId,
        clientId: sessionClientId
      });
    } catch (err) {
      console.error(`❌ OTP send failed:`, err.message);
      return res.status(503).json({
        ok: false,
        error: err.message,
        channel: 'whatsapp_node'
      });
    }
  }
);

module.exports = router;
