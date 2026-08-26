const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const authMiddleware = require('../middleware/auth');
const { getOwnerUserId, applySourceScope } = require('../utils/accountScope');
const { getOwnerSubscription } = require('../utils/subscription');

const viewSourcesFor = (sub) => {
  const catalog = sub.sources || [];
  if (catalog.length === 0) return null;
  return sub.enabledSources || [];
};

// GET /api/logs - get all logs for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { campaignId, clientId, direction, status, source, page = 1, limit = 50 } = req.query;
    const pageNumber = parseInt(page, 10) || 1;
    const limitNumber = parseInt(limit, 10) || 50;
    const filter = { userId: getOwnerUserId(req.user) };
    const sub = await getOwnerSubscription(req.user);
    const otpNumberId = String(clientId || '').trim();

    // Prefer OTP number filter (multi-number switch). Skip source catalog when number is set.
    if (otpNumberId) {
      filter.clientId = otpNumberId;
    } else {
      applySourceScope(filter, req.user, source, viewSourcesFor(sub));
    }

    if (campaignId) filter.campaignId = campaignId;
    if (direction) filter.direction = direction;
    if (status) filter.status = status;

    const logs = await MessageLog.listWithDetails(filter, {
      offset: (pageNumber - 1) * limitNumber,
      limit: limitNumber
    });

    const total = await MessageLog.countDocuments(filter);

    res.json({ logs, total, page: pageNumber, limit: limitNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stats - get aggregated stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { clientId, campaignId, source } = req.query;
    const filter = { userId: getOwnerUserId(req.user) };
    if (campaignId) filter.campaignId = campaignId;
    const sub = await getOwnerSubscription(req.user);
    const viewSources = viewSourcesFor(sub);
    const otpNumberId = String(clientId || '').trim();
    if (otpNumberId) {
      filter.clientId = otpNumberId;
    } else {
      applySourceScope(filter, req.user, source, viewSources);
    }

    const stats = await MessageLog.getStats(filter);
    const ownerId = getOwnerUserId(req.user);
    const knownSources = (sub.enabledSources && sub.enabledSources.length)
      ? sub.enabledSources
      : await MessageLog.listKnownSources(ownerId);
    const bySourceFilter = { userId: ownerId };
    if (otpNumberId) {
      bySourceFilter.clientId = otpNumberId;
    } else {
      applySourceScope(bySourceFilter, req.user, null, viewSources);
    }
    const bySource = await MessageLog.getStatsBySource(bySourceFilter);
    res.json({
      stats: stats || { total: 0, sent: 0, failed: 0, received: 0, outgoing: 0, incoming: 0 },
      bySource,
      enabledSources: sub.enabledSources || [],
      knownSources,
      allowSourceSwitch: Boolean(sub.allowSourceSwitch),
      canSwitchSources: Boolean(sub.allowSourceSwitch)
        && Boolean(req.user.parentUserId)
        && !req.user.source
        && (sub.enabledSources || []).length >= 2
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
