const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { sendMessage, isClientConnected, waitForClientReady } = require('../services/whatsappManager');
const { sendBalanceExhaustedEmail } = require('../services/balanceNotifier');
const authMiddleware = require('../middleware/auth');
const { getOwnerUserId, getLockedSource } = require('../utils/accountScope');
const { resolveMessageSource } = require('../utils/messageSource');
const { requireSendBalance, chargeSendBalance } = require('../utils/messageBilling');
const { getOwnerSubscription, assertSourceAllowed } = require('../utils/subscription');

const CLIENT_NOT_FOUND_HELP =
  'Client not found for this account. Call GET /api/clients with the same Bearer token and use the `_id` field (or session `clientId` like client_xxx).';

const resolveWhatsAppClient = async (clientIdParam, userId) => {
  const id = String(clientIdParam || '').trim();
  if (!id) return null;

  const base = { userId, isActive: true };
  const byDbId = await WhatsAppClientModel.findOne({ ...base, _id: id });
  if (byDbId) return byDbId;
  return (await WhatsAppClientModel.findOne({ ...base, clientId: id })) || null;
};

const logBalanceEmailResult = (context, result, email) => {
  console.log(
    `[BALANCE_EMAIL] context=${context} ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${email || 'n/a'}`
  );
};

// POST /api/messages/send - Send a single message (OTP / Laravel use /api/otp/send)
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { clientId, phone, message, mediaUrl } = req.body;
    if (!clientId || !phone || (!message && !mediaUrl)) {
      return res.status(400).json({
        error: 'clientId and phone are required; provide message and/or mediaUrl'
      });
    }

    const source = getLockedSource(req.user) || resolveMessageSource(req);
    const sub = await getOwnerSubscription(req.user);
    const sourceCheck = assertSourceAllowed(sub, source);
    if (!sourceCheck.ok) {
      return res.status(403).json({ error: sourceCheck.error });
    }

    const dbClient = await resolveWhatsAppClient(clientId, getOwnerUserId(req.user));
    if (!dbClient) {
      return res.status(404).json({ error: CLIENT_NOT_FOUND_HELP });
    }
    const balanceCheck = await requireSendBalance({
      user: req.user,
      dbClient,
      source,
      required: 1
    });
    if (!balanceCheck.ok) {
      sendBalanceExhaustedEmail({
        userId: getOwnerUserId(req.user),
        email: req.user.email,
        name: req.user.name
      })
        .then((result) => logBalanceEmailResult('single_send_blocked', result, req.user.email))
        .catch((err) => logBalanceEmailResult('single_send_blocked', { ok: false, reason: err.message }, req.user.email));
      return res.status(403).json({
        error: balanceCheck.error,
        balanceExhausted: true,
        currentBalance: balanceCheck.currentBalance || 0
      });
    }
    if (dbClient.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp client is not connected' });
    }
    if (!isClientConnected(dbClient.clientId)) {
      return res.status(503).json({
        error:
          'WhatsApp session is starting on the server. Wait until the client shows Ready, then try again.'
      });
    }

    const sendOpts = mediaUrl && String(mediaUrl).trim() ? { mediaUrl: String(mediaUrl).trim() } : null;
    await waitForClientReady(dbClient.clientId);
    const result = await sendMessage(
      dbClient.clientId,
      phone,
      message != null ? String(message) : '',
      sendOpts
    );

    await chargeSendBalance({
      user: req.user,
      dbClient,
      source,
      amount: 1
    });
    const updatedBalance = await WhatsAppClientModel.getBalance(dbClient._id);
    if (updatedBalance !== null && updatedBalance <= 0) {
      sendBalanceExhaustedEmail({
        userId: getOwnerUserId(req.user),
        email: req.user.email,
        name: req.user.name
      })
        .then((result) => logBalanceEmailResult('single_send_reached_zero', result, req.user.email))
        .catch((err) => logBalanceEmailResult('single_send_reached_zero', { ok: false, reason: err.message }, req.user.email));
    }

    const logText =
      [message, mediaUrl && `(media: ${mediaUrl})`].filter(Boolean).join(' ') || '(media only)';

    await MessageLog.create({
      userId: getOwnerUserId(req.user),
      clientId: dbClient._id,
      phone,
      message: logText,
      direction: 'outgoing',
      status: 'sent',
      whatsappMessageId: result?.id?._serialized,
      source
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
