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
const otpAuthMiddleware = require('../middleware/otpAuth');

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

const resolveOtpClient = async (clientIdParam, userId = null) => {
  const explicit = String(
    clientIdParam ||
      process.env.OTP_DEFAULT_CLIENT_ID ||
      process.env.WHATSAPP_NODE_CLIENT_ID ||
      ''
  ).trim();

  const belongsToUser = (client) => {
    if (!userId) return true;
    return String(client.userId) === String(userId);
  };

  if (explicit) {
    const bySession = await WhatsAppClientModel.findOne({
      clientId: explicit,
      isActive: true,
      status: 'connected'
    });
    if (bySession && belongsToUser(bySession)) return bySession;

    const byDbId = await WhatsAppClientModel.findOne({
      _id: explicit,
      isActive: true,
      status: 'connected'
    });
    if (byDbId && belongsToUser(byDbId)) return byDbId;
    return null;
  }

  const filter = { isActive: true, status: 'connected' };
  if (userId) filter.userId = userId;
  const connected = await WhatsAppClientModel.find(filter);
  return connected[0] || null;
};

const ensureClientReadyForSend = async (sessionClientId) => {
  if (!isClientConnected(sessionClientId)) {
    console.log(`⏳ OTP: waiting for WhatsApp client ${sessionClientId} to come online...`);
  }
  await waitForClientReady(sessionClientId);
};

const otpCodeValidator = body('code')
  .optional()
  .trim()
  .notEmpty()
  .withMessage('code is required');

const otpAltValidator = body('otp')
  .optional()
  .trim()
  .notEmpty()
  .withMessage('otp is required');

/**
 * POST /api/otp/send
 *
 * Body: { phone, code | otp, clientId?, message? }
 * Auth: Bearer WHATSAPP_NODE_TOKEN (JWT) OR X-Service-Key OTP_SERVICE_SECRET
 */
router.post(
  '/send',
  otpAuthMiddleware,
  [
    body('phone').trim().notEmpty().withMessage('phone is required'),
    otpCodeValidator,
    otpAltValidator
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }

    const code = String(req.body.code || req.body.otp || '').trim();
    if (!code) {
      return res.status(400).json({ ok: false, error: 'code or otp is required' });
    }

    try {
      const phone = normalizePhone(req.body.phone).replace('@c.us', '');
      const userId = req.user?._id || null;
      const dbClient = await resolveOtpClient(req.body.clientId, userId);

      if (!dbClient) {
        return res.status(503).json({
          ok: false,
          error:
            'No connected WhatsApp client available for OTP. Connect a client or set WHATSAPP_NODE_CLIENT_ID / OTP_DEFAULT_CLIENT_ID.'
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
