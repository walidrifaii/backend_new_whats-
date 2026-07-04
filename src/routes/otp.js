const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const {
  sendMessage,
  isClientConnected,
  waitForClientReady,
  getClient
} = require('../services/whatsappManager');
const { normalizePhone } = require('../utils/helpers');
const otpAuthMiddleware = require('../middleware/otpAuth');

const getOtpExpiresMinutes = () => {
  const n = parseInt(process.env.OTP_EXPIRES_MINUTES || '5', 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

/** Shorter than WA_SEND_READY_WAIT_MS so Laravel Http::timeout(20) does not fire first. */
const getOtpSendReadyWaitMs = () => {
  const n = parseInt(process.env.OTP_SEND_READY_WAIT_MS || '15000', 10);
  return Number.isFinite(n) && n > 0 ? n : 15000;
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

  const isLiveForOtp = (client) => {
    if (!client) return false;
    if (client.status === 'connected') return true;
    if (!isClientConnected(client.clientId)) return false;
    const wClient = getClient(client.clientId);
    return Boolean(wClient?.info?.wid?.user);
  };

  const pickClient = (client) => {
    if (!client || !belongsToUser(client)) return null;
    return isLiveForOtp(client) ? client : null;
  };

  if (explicit) {
    const bySession = await WhatsAppClientModel.findOne({
      clientId: explicit,
      isActive: true
    });
    const fromSession = pickClient(bySession);
    if (fromSession) return fromSession;

    const byDbId = await WhatsAppClientModel.findOne({
      _id: explicit,
      isActive: true
    });
    const fromDb = pickClient(byDbId);
    if (fromDb) return fromDb;
    return null;
  }

  const filter = { isActive: true };
  if (userId) filter.userId = userId;
  const candidates = await WhatsAppClientModel.find(filter);
  return candidates.find((c) => isLiveForOtp(c)) || null;
};

const ensureClientReadyForSend = async (sessionClientId) => {
  if (!isClientConnected(sessionClientId)) {
    console.log(`⏳ OTP: waiting for WhatsApp client ${sessionClientId} to come online...`);
  }
  await waitForClientReady(sessionClientId, getOtpSendReadyWaitMs());
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

      const minAck = parseInt(process.env.OTP_MIN_ACK || '2', 10);
      const result = await sendMessage(sessionClientId, phone, text, {
        requireRegistered: true,
        waitForAck: Number.isFinite(minAck) ? minAck : 2,
        waitForAckMs: parseInt(process.env.OTP_ACK_WAIT_MS || '30000', 10)
      });
      const messageId = result?.id?._serialized || null;
      const chatId = result?._deliveryMeta?.chatId || null;
      const deliveryAck = result?._deliveryMeta?.ack ?? null;

      await MessageLog.create({
        userId: dbClient.userId,
        clientId: dbClient._id,
        phone,
        message: text,
        direction: 'outgoing',
        status: 'sent',
        whatsappMessageId: messageId
      });

      console.log(
        `✅ OTP sent to ${phone} via ${sessionClientId} chatId=${chatId} ack=${deliveryAck} msgId=${messageId}`
      );

      return res.json({
        ok: true,
        message: 'OTP sent.',
        channel: 'whatsapp_node',
        expires_in: getOtpExpiresMinutes() * 60,
        messageId,
        chatId,
        deliveryAck,
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
