const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const authMiddleware = require('../middleware/auth');

// GET /api/logs - get all logs for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { campaignId, clientId, direction, status, page = 1, limit = 50 } = req.query;
    const pageNumber = parseInt(page, 10) || 1;
    const limitNumber = parseInt(limit, 10) || 50;
    const filter = { userId: req.user._id };

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
    const { clientId, campaignId } = req.query;
    const filter = { userId: req.user._id };
    if (clientId) filter.clientId = clientId;
    if (campaignId) filter.campaignId = campaignId;

    const stats = await MessageLog.getStats(filter);
    res.json({
      stats: stats || { total: 0, sent: 0, failed: 0, received: 0, outgoing: 0, incoming: 0 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
