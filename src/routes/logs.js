const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const authMiddleware = require('../middleware/auth');
const { getOwnerUserId, applySourceScope } = require('../utils/accountScope');

// GET /api/logs - get all logs for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { campaignId, clientId, direction, status, source, page = 1, limit = 50 } = req.query;
    const pageNumber = parseInt(page, 10) || 1;
    const limitNumber = parseInt(limit, 10) || 50;
    const filter = { userId: getOwnerUserId(req.user) };
    applySourceScope(filter, req.user, source);

    if (campaignId) filter.campaignId = campaignId;
    if (clientId) filter.clientId = clientId;
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
    if (clientId) filter.clientId = clientId;
    if (campaignId) filter.campaignId = campaignId;
    applySourceScope(filter, req.user, source);

    const stats = await MessageLog.getStats(filter);
    const bySource = await MessageLog.getStatsBySource({
      userId: getOwnerUserId(req.user),
      ...(filter.source ? { source: filter.source } : {})
    });
    res.json({
      stats: stats || { total: 0, sent: 0, failed: 0, received: 0, outgoing: 0, incoming: 0 },
      bySource
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
