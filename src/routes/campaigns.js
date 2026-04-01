const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { query } = require('../db/mysql');
const { sendBalanceExhaustedEmail } = require('../services/balanceNotifier');
const { startCampaign, pauseCampaign, resumeCampaign } = require('../services/campaignQueue');
const authMiddleware = require('../middleware/auth');

// GET /api/campaigns
router.get('/', authMiddleware, async (req, res) => {
  try {
    const campaigns = await Campaign.find(
      { userId: req.user._id },
      { sort: { createdAt: -1 } }
    );
    const clients = await WhatsAppClientModel.find({ userId: req.user._id, isActive: true });
    const clientsById = new Map(clients.map((c) => [c._id, c]));
    const hydratedCampaigns = campaigns.map((campaign) => ({
      ...campaign,
      clientId: clientsById.get(campaign.clientId) || campaign.clientId
    }));
    res.json({ campaigns: hydratedCampaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns
router.post('/', authMiddleware, [
  body('name').trim().notEmpty().withMessage('Campaign name is required'),
  body('clientId').notEmpty().withMessage('WhatsApp client is required'),
  body('message').custom((value, { req }) => {
    const msg = String(value || '').trim();
    const cap = String(req.body.caption || '').trim();
    const img = String(req.body.imageUrl || req.body.mediaUrl || '').trim();
    if (!msg && !cap && !img) {
      throw new Error('Message, caption, or image URL is required');
    }
    return true;
  })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, message, clientId, minDelay, maxDelay, imageUrl, caption } = req.body;
    const textBody = String(message || '').trim();
    const textCaption = String(caption || '').trim();
    const img = String(imageUrl || req.body.mediaUrl || '').trim();
    const combinedMessage = textCaption || textBody;

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
      message: combinedMessage,
      mediaUrl: img || null,
      mediaType: img ? 'image' : null,
      minDelay: minDelay || 20000,
      maxDelay: maxDelay || 30000,
      status: 'draft'
    });

    res.status(201).json({ campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/auto - Create campaign + contacts + optional auto start
router.post('/auto', authMiddleware, [
  body('message').custom((value, { req }) => {
    const msg = String(value || '').trim();
    const cap = String(req.body.caption || '').trim();
    const img = String(req.body.imageUrl || req.body.mediaUrl || '').trim();
    if (!msg && !cap && !img) {
      throw new Error('Message, caption, or image URL is required');
    }
    return true;
  }),
  body('contacts').isArray({ min: 1 }).withMessage('contacts array is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const {
      name,
      message,
      contacts,
      minDelay,
      maxDelay,
      autoStart = true,
      imageUrl,
      caption
    } = req.body;
    const textBody = String(message || '').trim();
    const textCaption = String(caption || '').trim();
    const img = String(imageUrl || req.body.mediaUrl || '').trim();
    const combinedMessage = textCaption || textBody;

    const client = await WhatsAppClientModel.findOne({
      userId: req.user._id,
      isActive: true,
      status: 'connected'
    });
    if (!client) {
      return res.status(400).json({
        error: 'No connected WhatsApp client found. Connect a number first.'
      });
    }

    const campaignName = String(name || `Auto Campaign ${new Date().toISOString()}`).trim();
    const campaign = await Campaign.create({
      userId: req.user._id,
      clientId: client._id,
      name: campaignName || `Auto Campaign ${new Date().toISOString()}`,
      message: combinedMessage,
      mediaUrl: img || null,
      mediaType: img ? 'image' : null,
      minDelay: minDelay || 20000,
      maxDelay: maxDelay || 30000,
      status: 'draft'
    });

    const seenPhones = new Set();
    const contactDocs = [];

    for (const item of contacts) {
      let phone = '';
      let contactName = '';
      let variables = {};

      if (typeof item === 'string') {
        phone = item.trim();
      } else if (item && typeof item === 'object') {
        phone = String(item.phone || '').trim();
        contactName = String(item.name || '').trim();
        const { phone: _p, name: _n, variables: vars, ...rest } = item;
        variables = (vars && typeof vars === 'object' && !Array.isArray(vars)) ? vars : {};
        Object.entries(rest).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') variables[k] = v;
        });
      }

      if (!phone || seenPhones.has(phone)) continue;
      seenPhones.add(phone);

      contactDocs.push({
        userId: req.user._id,
        campaignId: campaign._id,
        phone,
        name: contactName,
        variables,
        status: 'pending'
      });
    }

    if (contactDocs.length === 0) {
      return res.status(400).json({ error: 'No valid contacts found' });
    }

    await Contact.insertMany(contactDocs);
    await Campaign.findByIdAndUpdate(campaign._id, { totalContacts: contactDocs.length }, { new: true });

    if (autoStart) {
      await startCampaign(campaign._id);
    }

    return res.status(201).json({
      message: autoStart
        ? 'Campaign created and started'
        : 'Campaign created',
      campaignId: campaign._id,
      clientId: client._id,
      totalContacts: contactDocs.length,
      status: autoStart ? 'running' : 'draft'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const client = await WhatsAppClientModel.findOne({ _id: campaign.clientId, userId: req.user._id });
    res.json({ campaign: { ...campaign, clientId: client || campaign.clientId } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/start
router.post('/:id/start', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const client = await WhatsAppClientModel.findOne({ _id: campaign.clientId, userId: req.user._id });
    if (!client) return res.status(404).json({ error: 'WhatsApp client not found' });

    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: `Cannot start campaign in status: ${campaign.status}` });
    }

    if (client.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp client is not connected' });
    }

    if (campaign.totalContacts === 0) {
      return res.status(400).json({ error: 'No contacts uploaded for this campaign' });
    }

    const balance = await User.getBalance(req.user._id);
    if (balance <= 0) {
      const reason = 'Failed: insufficient message balance. You need to charge balance in message.';
      const pendingRows = await query(
        `SELECT COUNT(*) AS total FROM contacts WHERE campaign_id = ? AND status = 'pending'`,
        [campaign._id]
      );
      const pendingCount = pendingRows[0]?.total || 0;
      if (pendingCount > 0) {
        await query(
          `UPDATE contacts
           SET status = 'failed', error = ?
           WHERE campaign_id = ? AND status = 'pending'`,
          [reason, campaign._id]
        );
        await Campaign.findByIdAndUpdate(
          campaign._id,
          { status: 'failed', completedAt: new Date(), $inc: { failedCount: pendingCount } },
          { new: true }
        );
      }

      sendBalanceExhaustedEmail({
        userId: req.user._id,
        email: req.user.email,
        name: req.user.name
      })
        .then((result) => {
          console.log(
            `[BALANCE_EMAIL] context=campaign_start_blocked ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${req.user.email || 'n/a'}`
          );
        })
        .catch((err) => {
          console.log(
            `[BALANCE_EMAIL] context=campaign_start_blocked ok=false reason=${err.message || 'unknown'} email=${req.user.email || 'n/a'}`
          );
        });
      return res.status(403).json({
        error: 'You need to charge balance in message.',
        balanceExhausted: true,
        currentBalance: 0,
        contactsMarkedFailed: pendingCount
      });
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
