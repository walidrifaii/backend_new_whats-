const mongoose = require('mongoose');

const MessageLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppClient', required: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  phone: { type: String, required: true },
  message: { type: String, required: true },
  direction: { type: String, enum: ['outgoing', 'incoming'], default: 'outgoing' },
  status: { type: String, enum: ['sent', 'failed', 'received'], default: 'sent' },
  whatsappMessageId: { type: String },
  error: { type: String },
  timestamp: { type: Date, default: Date.now }
});

MessageLogSchema.index({ userId: 1, timestamp: -1 });
MessageLogSchema.index({ campaignId: 1, timestamp: -1 });
MessageLogSchema.index({ clientId: 1, timestamp: -1 });

module.exports = mongoose.model('MessageLog', MessageLogSchema);
