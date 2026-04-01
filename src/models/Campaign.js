const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppClient', required: true },
  name: { type: String, required: true, trim: true },
  message: { type: String, required: true },
  mediaUrl: { type: String },
  mediaType: { type: String, enum: ['image', 'video', 'document', null] },
  // Caption shown below the image (supports {name}, {link} etc.)
  imageCaption: { type: String },
  status: {
    type: String,
    enum: ['draft', 'running', 'paused', 'completed', 'failed'],
    default: 'draft'
  },
  minDelay: { type: Number, default: 20000 },
  maxDelay: { type: Number, default: 30000 },
  totalContacts: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  pendingCount: { type: Number, default: 0 },
  startedAt: { type: Date },
  completedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

CampaignSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  this.pendingCount = this.totalContacts - this.sentCount - this.failedCount;
  next();
});

module.exports = mongoose.model('Campaign', CampaignSchema);
