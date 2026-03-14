const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Papa = require('papaparse');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const authMiddleware = require('../middleware/auth');

// Configure multer for CSV uploads
const uploadsDir = path.resolve(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files allowed'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// GET /api/contacts/:campaignId
router.get('/:campaignId', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.campaignId, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { page = 1, limit = 50, status } = req.query;
    const filter = { campaignId: req.params.campaignId };
    if (status) filter.status = status;

    const contacts = await Contact.find(filter)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: 1 });
    const total = await Contact.countDocuments(filter);

    res.json({ contacts, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/:campaignId/upload - Upload CSV
router.post('/:campaignId/upload', authMiddleware, upload.single('contacts'), async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.campaignId, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Can only upload contacts to draft or paused campaigns' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const csvContent = fs.readFileSync(req.file.path, 'utf-8');
    const { data, errors } = Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase()
    });

    if (errors.length > 0) {
      return res.status(400).json({ error: 'CSV parse error', details: errors });
    }

    // Must have a 'phone' column
    if (data.length > 0 && !('phone' in data[0])) {
      return res.status(400).json({ error: 'CSV must have a "phone" column' });
    }

    // Build contact docs
    const contactDocs = [];
    const seen = new Set();
    for (const row of data) {
      const phone = row.phone?.toString().trim();
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);

      // Extract known fields and put rest in variables
      const { phone: _p, name, ...rest } = row;
      const variables = new Map(Object.entries(rest).filter(([, v]) => v));

      contactDocs.push({
        userId: req.user._id,
        campaignId: campaign._id,
        phone,
        name: name?.trim() || '',
        variables,
        status: 'pending'
      });
    }

    if (contactDocs.length === 0) {
      return res.status(400).json({ error: 'No valid contacts found in CSV' });
    }

    // Remove old pending contacts
    await Contact.deleteMany({ campaignId: campaign._id, status: 'pending' });

    // Insert new contacts
    await Contact.insertMany(contactDocs);

    // Update campaign total
    await Campaign.findByIdAndUpdate(campaign._id, { totalContacts: contactDocs.length });

    // Cleanup temp file
    fs.unlinkSync(req.file.path);

    res.json({
      message: `${contactDocs.length} contacts uploaded successfully`,
      total: contactDocs.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts/:campaignId/add - Add single contact
router.post('/:campaignId/add', authMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.campaignId, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { phone, name, ...variables } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    const contact = await Contact.create({
      userId: req.user._id,
      campaignId: campaign._id,
      phone: phone.trim(),
      name: name?.trim() || '',
      variables: new Map(Object.entries(variables))
    });

    await Campaign.findByIdAndUpdate(campaign._id, { $inc: { totalContacts: 1 } });

    res.status(201).json({ contact });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
