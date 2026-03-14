const mongoose = require('mongoose');

const WhatsAppClientSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true },
  clientId: { type: String, unique: true, required: true },
  status: {
    type: String,
    enum: ['disconnected', 'initializing', 'qr_ready', 'connected', 'auth_failure'],
    default: 'disconnected'
  },
  qrCode: { type: String },
  sessionPath: { type: String },
  lastConnected: { type: Date },
  messagesSent: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

WhatsAppClientSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('WhatsAppClient', WhatsAppClientSchema);
