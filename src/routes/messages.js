const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const MessageJob = require('../models/MessageJob');
const MessageJobItem = require('../models/MessageJobItem');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { sendMessage, isClientConnected } = require('../services/whatsappManager');
const { startMessageJob, isClientSending } = require('../services/messageJobQueue');
const { sendBalanceExhaustedEmail } = require('../services/balanceNotifier');
const { sanitizeMediaUrl, validateMediaUrlReachable } = require('../utils/campaignMedia');
const {
  calculateBulkSchedule,
  buildItemSchedule,
  estimateCompletionAt,
  DEFAULT_SPREAD_HOURS
} = require('../utils/bulkSchedule');
const authMiddleware = require('../middleware/auth');

const MAX_BULK_PHONES = Math.max(1, parseInt(process.env.MAX_BULK_PHONES, 10) || 500);

const CLIENT_NOT_FOUND_HELP =
  'Client not found for this account. Call GET /api/clients with the same Bearer token and use the `_id` field (or session `clientId` like client_xxx).';

/**
 * Resolve a WhatsApp client by database id (_id) or session clientId (client_xxx).
 */
const resolveWhatsAppClient = async (clientIdParam, userId) => {
  const id = String(clientIdParam || '').trim();
  if (!id) return null;

  const base = { userId, isActive: true };

  const byDbId = await WhatsAppClientModel.findOne({ ...base, _id: id });
  if (byDbId) return byDbId;

  const bySessionId = await WhatsAppClientModel.findOne({ ...base, clientId: id });
  return bySessionId || null;
};

const logBalanceEmailResult = (context, result, email) => {
  console.log(
    `[BALANCE_EMAIL] context=${context} ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${email || 'n/a'}`
  );
};

const normalizePhonesList = (phones) => {
  if (!Array.isArray(phones)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of phones) {
    const phone = String(raw || '').trim().replace(/@c\.us$/i, '').replace(/\D/g, '');
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    result.push(phone);
  }
  return result;
};

const formatJobResponse = (job) => ({
  jobId: job._id,
  status: job.status,
  total: job.totalCount,
  sent: job.sentCount,
  failed: job.failedCount,
  pending: job.pendingCount,
  message: job.message,
  mediaUrl: job.mediaUrl,
  spreadHours: job.spreadHours,
  delayBetweenMessagesMs: job.minDelay,
  delayBetweenMessagesSeconds: job.minDelay ? Math.round(job.minDelay / 1000) : 0,
  minDelay: job.minDelay,
  maxDelay: job.maxDelay,
  estimatedCompletedAt: job.estimatedCompletedAt,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
  createdAt: job.createdAt
});

const buildSchedulePayload = (phoneCount, spreadHours) => {
  const schedule = calculateBulkSchedule(phoneCount, spreadHours);
  const startAt = new Date();
  return {
    schedule: {
      phoneCount: schedule.phoneCount,
      maxPhones: schedule.maxPhones,
      spreadHours: schedule.spreadHours,
      maxSpreadHours: schedule.maxSpreadHours,
      delayBetweenMessagesMs: schedule.delayBetweenMessagesMs,
      delayBetweenMessagesSeconds: schedule.delayBetweenMessagesSeconds,
      minDelayMs: schedule.minDelayMs,
      maxDelayMs: schedule.maxDelayMs,
      estimatedTotalMs: schedule.estimatedTotalMs,
      estimatedHours: schedule.estimatedHours,
      estimatedDays: schedule.estimatedDays,
      estimatedDuration: schedule.estimatedDuration,
      maxTotalDurationAtMaxPhones: schedule.maxTotalDurationAtMaxPhones,
      messagesPerHour: schedule.messagesPerHour,
      spreadTargetMet: schedule.spreadTargetMet,
      note: schedule.note,
      ...(schedule.warning ? { warning: schedule.warning } : {})
    },
    estimatedCompletedAt: estimateCompletionAt(phoneCount, schedule.delayBetweenMessagesMs, startAt)
  };
};

// POST /api/messages/send-bulk/preview - Estimate duration before sending
router.post('/send-bulk/preview', authMiddleware, async (req, res) => {
  try {
    const { phones, spreadHours } = req.body;
    const phoneList = normalizePhonesList(phones);
    if (phoneList.length === 0) {
      return res.status(400).json({ error: 'phones must be a non-empty array of valid numbers' });
    }
    if (phoneList.length > MAX_BULK_PHONES) {
      return res.status(400).json({ error: `Maximum ${MAX_BULK_PHONES} phones per bulk job` });
    }

    const parsedSpread = spreadHours != null ? parseFloat(spreadHours) : DEFAULT_SPREAD_HOURS;
    const safeSpreadHours = Number.isFinite(parsedSpread) && parsedSpread > 0
      ? parsedSpread
      : DEFAULT_SPREAD_HOURS;

    const preview = buildSchedulePayload(phoneList.length, safeSpreadHours);
    const itemSchedule = buildItemSchedule(phoneList, preview.schedule.delayBetweenMessagesMs);

    res.json({
      total: phoneList.length,
      spreadHours: safeSpreadHours,
      ...preview,
      itemSchedule: itemSchedule.map((row, index) => ({
        index: index + 1,
        phone: row.phone,
        scheduledAt: row.scheduledAt
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/send-bulk - Same message (and optional media) to many phones
router.post('/send-bulk', authMiddleware, async (req, res) => {
  try {
    const {
      clientId,
      message,
      mediaUrl: rawMediaUrl,
      phones,
      spreadHours
    } = req.body;

    const text = message != null ? String(message).trim() : '';
    const mediaUrl = rawMediaUrl ? sanitizeMediaUrl(String(rawMediaUrl)) : null;
    const phoneList = normalizePhonesList(phones);

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!text && !mediaUrl) {
      return res.status(400).json({ error: 'Provide message and/or mediaUrl' });
    }
    if (phoneList.length === 0) {
      return res.status(400).json({ error: 'phones must be a non-empty array of valid numbers' });
    }
    if (phoneList.length > MAX_BULK_PHONES) {
      return res.status(400).json({ error: `Maximum ${MAX_BULK_PHONES} phones per bulk job` });
    }

    const balance = await User.getBalance(req.user._id);
    if (balance < phoneList.length) {
      return res.status(403).json({
        error: 'Insufficient message balance for this bulk job.',
        balanceExhausted: balance <= 0,
        currentBalance: balance,
        required: phoneList.length
      });
    }

    const dbClient = await resolveWhatsAppClient(clientId, req.user._id);
    if (!dbClient) {
      return res.status(404).json({ error: CLIENT_NOT_FOUND_HELP });
    }
    if (dbClient.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp client is not connected' });
    }
    if (!isClientConnected(dbClient.clientId)) {
      return res.status(400).json({
        error:
          'WhatsApp session is offline on the server. Open the dashboard and reconnect this client before sending.'
      });
    }
    if (isClientSending(dbClient.clientId)) {
      return res.status(409).json({ error: 'This WhatsApp client is already sending messages' });
    }

    if (mediaUrl) {
      const mediaCheck = await validateMediaUrlReachable(mediaUrl);
      if (!mediaCheck.ok) {
        return res.status(400).json({ error: mediaCheck.reason });
      }
    }

    const parsedSpread = spreadHours != null ? parseFloat(spreadHours) : DEFAULT_SPREAD_HOURS;
    const safeSpreadHours = Number.isFinite(parsedSpread) && parsedSpread > 0
      ? parsedSpread
      : DEFAULT_SPREAD_HOURS;

    const schedule = calculateBulkSchedule(phoneList.length, safeSpreadHours);
    const startAt = new Date();
    const estimatedCompletedAt = estimateCompletionAt(
      phoneList.length,
      schedule.delayBetweenMessagesMs,
      startAt
    );
    const scheduledItems = buildItemSchedule(phoneList, schedule.delayBetweenMessagesMs, startAt);

    const job = await MessageJob.create({
      userId: req.user._id,
      clientId: dbClient._id,
      message: text,
      mediaUrl,
      status: 'queued',
      minDelay: schedule.minDelayMs,
      maxDelay: schedule.maxDelayMs,
      spreadHours: safeSpreadHours,
      estimatedCompletedAt,
      totalCount: phoneList.length
    });

    await MessageJobItem.insertMany(
      scheduledItems.map((row) => ({
        jobId: job._id,
        userId: req.user._id,
        phone: row.phone,
        status: 'pending',
        scheduledAt: row.scheduledAt
      }))
    );

    try {
      await startMessageJob(job._id);
    } catch (startErr) {
      await MessageJobItem.failPendingByJobId(job._id, startErr.message);
      await MessageJob.findByIdAndUpdate(job._id, { status: 'failed', completedAt: new Date() });
      throw startErr;
    }

    res.status(202).json({
      message: 'Bulk job started',
      jobId: job._id,
      total: phoneList.length,
      status: 'running',
      spreadHours: safeSpreadHours,
      schedule: {
        delayBetweenMessagesMs: schedule.delayBetweenMessagesMs,
        delayBetweenMessagesSeconds: schedule.delayBetweenMessagesSeconds,
        minDelayMs: schedule.minDelayMs,
        maxDelayMs: schedule.maxDelayMs,
        estimatedTotalMs: schedule.estimatedTotalMs,
        estimatedHours: schedule.estimatedHours,
        estimatedDays: schedule.estimatedDays,
        estimatedDuration: schedule.estimatedDuration,
        maxPhones: schedule.maxPhones,
        maxSpreadHours: schedule.maxSpreadHours,
        maxTotalDurationAtMaxPhones: schedule.maxTotalDurationAtMaxPhones,
        messagesPerHour: schedule.messagesPerHour,
        spreadTargetMet: schedule.spreadTargetMet,
        note: schedule.note,
        ...(schedule.warning ? { warning: schedule.warning } : {})
      },
      estimatedCompletedAt,
      note: 'Delays are fixed (minDelay = maxDelay). Messages send one by one on each scheduledAt time.'
    });
  } catch (err) {
    if (err.message === 'This WhatsApp client is already sending messages') {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/jobs/:jobId - Bulk job status
router.get('/jobs/:jobId', authMiddleware, async (req, res) => {
  try {
    const job = await MessageJob.findOne({
      _id: req.params.jobId,
      userId: req.user._id
    });
    if (!job) return res.status(404).json({ error: 'Bulk job not found' });

    const failedSamples = await MessageJobItem.find(
      { jobId: job._id, status: 'failed' },
      { limit: 5 }
    );

    res.json({
      ...formatJobResponse(job),
      schedule: {
        spreadHours: job.spreadHours,
        delayBetweenMessagesMs: job.minDelay,
        delayBetweenMessagesSeconds: job.minDelay ? Math.round(job.minDelay / 1000) : 0,
        estimatedCompletedAt: job.estimatedCompletedAt
      },
      recentErrors: failedSamples.map((item) => ({
        phone: item.phone,
        error: item.error || 'Unknown error'
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/jobs/:jobId/items - Per-recipient results
router.get('/jobs/:jobId/items', authMiddleware, async (req, res) => {
  try {
    const job = await MessageJob.findOne({
      _id: req.params.jobId,
      userId: req.user._id
    });
    if (!job) return res.status(404).json({ error: 'Bulk job not found' });

    const { page = 1, limit = 50, status } = req.query;
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const filter = { jobId: job._id, userId: req.user._id };
    if (status) filter.status = String(status);

    const items = await MessageJobItem.find(filter, {
      offset: (pageNumber - 1) * limitNumber,
      limit: limitNumber
    });
    const total = await MessageJobItem.countDocuments(filter);

    res.json({
      jobId: job._id,
      items,
      total,
      page: pageNumber,
      limit: limitNumber
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    const dbClient = await resolveWhatsAppClient(clientId, req.user._id);
    if (!dbClient) {
      return res.status(404).json({ error: CLIENT_NOT_FOUND_HELP });
    }
    if (dbClient.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp client is not connected' });
    }
    if (isClientSending(dbClient.clientId)) {
      return res.status(409).json({ error: 'This WhatsApp client is already sending messages' });
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
