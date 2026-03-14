const express = require('express');
const router = express.Router();
const MessageLog = require('../models/MessageLog');
const authMiddleware = require('../middleware/auth');

// GET /api/logs - get all logs for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { campaignId, clientId, direction, status, page = 1, limit = 50 } = req.query;
    const filter = { userId: req.user._id };

    if (campaignId) filter.campaignId = campaignId;
    if (clientId) filter.clientId = clientId;
    if (direction) filter.direction = direction;
    if (status) filter.status = status;

    const logs = await MessageLog.find(filter)
      .populate('clientId', 'name phone')
      .populate('campaignId', 'name')
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await MessageLog.countDocuments(filter);

    res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stats - get aggregated stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { clientId, campaignId } = req.query;
    const match = { userId: req.user._id };
    if (clientId) match.clientId = require('mongoose').Types.ObjectId(clientId);
    if (campaignId) match.campaignId = require('mongoose').Types.ObjectId(campaignId);

    const stats = await MessageLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          received: { $sum: { $cond: [{ $eq: ['$status', 'received'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'outgoing'] }, 1, 0] } },
          incoming: { $sum: { $cond: [{ $eq: ['$direction', 'incoming'] }, 1, 0] } }
        }
      }
    ]);

    res.json({ stats: stats[0] || { total: 0, sent: 0, failed: 0, received: 0, outgoing: 0, incoming: 0 } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
