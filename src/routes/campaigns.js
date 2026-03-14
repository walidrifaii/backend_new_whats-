const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Campaign = require('../models/Campaign');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { startCampaign, pauseCampaign, resumeCampaign } = require('../services/campaignQueue');
const authMiddleware = require('../middleware/auth');

// GET /api/campaigns
router.get('/', authMiddleware, async (req, res) => {
  try {
    const campaigns = await Campaign.find({ userId: req.user._id })
      .populate('clientId', 'name status clientId phone')
      .sort({ createdAt: -1 });
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns
router.post('/', authMiddleware, [
  body('name').trim().notEmpty().withMessage('Campaign name is required'),
  body('message').trim().notEmpty().withMessage('Message is required'),
  body('clientId').notEmpty().withMessage('WhatsApp client is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, message, clientId, minDelay, maxDelay } = req.body;

    const client = await WhatsAppClientModel.findOne({
      _id: clientId,
      userId: req.user._id,
      isActive: true
    });
    if (!client) return res.status(404).json({ error: 'WhatsApp client not found' });

    const campaign = await Campaign.create({
      userId: req.user._id,
      clientId,
      name,
      message,
      minDelay: minDelay || 20000,
      maxDelay: maxDelay || 30000,
      status: 'draft'
    });

    res.status(201).json({ campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id })
      .populate('clientId', 'name status clientId phone');
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/start
router.post('/:id/start', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id })
      .populate('clientId');
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: `Cannot start campaign in status: ${campaign.status}` });
    }

    if (campaign.clientId.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp client is not connected' });
    }

    if (campaign.totalContacts === 0) {
      return res.status(400).json({ error: 'No contacts uploaded for this campaign' });
    }

    await startCampaign(campaign._id);
    res.json({ message: 'Campaign started', campaignId: campaign._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (campaign.status !== 'running') {
      return res.status(400).json({ error: 'Campaign is not running' });
    }

    await pauseCampaign(campaign._id);
    res.json({ message: 'Campaign paused' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ message: 'Campaign deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
