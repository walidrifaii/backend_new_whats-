const mongoose = require('mongoose');

const ContactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
  name: { type: String, trim: true },
  phone: { type: String, required: true, trim: true },
  variables: { type: Map, of: String, default: {} },
  status: {
    type: String,
    enum: ['pending', 'sent', 'failed', 'skipped'],
    default: 'pending'
  },
  sentAt: { type: Date },
  error: { type: String },
  createdAt: { type: Date, default: Date.now }
});

ContactSchema.index({ campaignId: 1, status: 1 });
ContactSchema.index({ campaignId: 1, phone: 1 });

module.exports = mongoose.model('Contact', ContactSchema);
