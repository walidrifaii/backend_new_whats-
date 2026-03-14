const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const { emitToClient } = require('../utils/socket');

// In-memory map of active WhatsApp client instances
const activeClients = new Map();

const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : path.resolve(__dirname, '../../sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Creates and initializes a WhatsApp client for a given clientId
 */
const createWhatsAppClient = async (clientId) => {
  if (activeClients.has(clientId)) {
    console.log(`Client ${clientId} already active`);
    return activeClients.get(clientId);
  }

  console.log(`Initializing WhatsApp client: ${clientId}`);

  const wClient = new Client({
    authStrategy: new LocalAuth({
      clientId: clientId,
      dataPath: SESSIONS_DIR
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  // QR Code event
  wClient.on('qr', async (qr) => {
    console.log(`QR received for client: ${clientId}`);
    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { status: 'qr_ready', qrCode: qrDataUrl }
      );
      emitToClient(clientId, 'qr', { clientId, qr: qrDataUrl });
    } catch (err) {
      console.error(`QR generation error for ${clientId}:`, err);
    }
  });

  // Ready event
  wClient.on('ready', async () => {
    console.log(`✅ WhatsApp client ready: ${clientId}`);
    const info = wClient.info;
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      {
        status: 'connected',
        qrCode: null,
        phone: info?.wid?.user || '',
        lastConnected: new Date()
      }
    );
    emitToClient(clientId, 'ready', { clientId, phone: info?.wid?.user });
  });

  // Auth failure event
  wClient.on('auth_failure', async (msg) => {
    console.error(`Auth failure for ${clientId}:`, msg);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'auth_failure', qrCode: null }
    );
    emitToClient(clientId, 'auth_failure', { clientId, message: msg });
    activeClients.delete(clientId);
  });

  // Disconnected event
  wClient.on('disconnected', async (reason) => {
    console.log(`Client ${clientId} disconnected:`, reason);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null }
    );
    emitToClient(clientId, 'disconnected', { clientId, reason });
    activeClients.delete(clientId);
  });

  // Incoming message event
  wClient.on('message', async (msg) => {
    try {
      const dbClient = await WhatsAppClientModel.findOne({ clientId });
      if (!dbClient) return;

      console.log(`📨 Incoming message for ${clientId} from ${msg.from}: ${msg.body}`);

      await MessageLog.create({
        userId: dbClient.userId,
        clientId: dbClient._id,
        phone: msg.from.replace('@c.us', ''),
        message: msg.body,
        direction: 'incoming',
        status: 'received',
        whatsappMessageId: msg.id._serialized
      });

      emitToClient(clientId, 'incoming-message', {
        clientId,
        from: msg.from,
        body: msg.body,
        timestamp: msg.timestamp
      });
    } catch (err) {
      console.error('Error saving incoming message:', err);
    }
  });

  // Initialize the client
  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { status: 'initializing' }
  );

  activeClients.set(clientId, wClient);
  wClient.initialize();

  return wClient;
};

/**
 * Get an active client instance
 */
const getClient = (clientId) => activeClients.get(clientId);

/**
 * Destroy and remove a client
 */
const destroyClient = async (clientId) => {
  const wClient = activeClients.get(clientId);
  if (wClient) {
    try {
      await wClient.destroy();
    } catch (err) {
      console.error(`Error destroying client ${clientId}:`, err);
    }
    activeClients.delete(clientId);
  }
  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { status: 'disconnected', qrCode: null }
  );
};

/**
 * Send a message using an active client
 */
const sendMessage = async (clientId, phone, message) => {
  const wClient = activeClients.get(clientId);
  if (!wClient) throw new Error(`No active client for ${clientId}`);

  const dbClient = await WhatsAppClientModel.findOne({ clientId });
  if (!dbClient || dbClient.status !== 'connected') {
    throw new Error(`Client ${clientId} is not connected`);
  }

  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  const result = await wClient.sendMessage(chatId, message);

  // Update message count
  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { $inc: { messagesSent: 1 } }
  );

  return result;
};

/**
 * On server start: re-initialize clients that were previously connected
 */
const initWhatsAppManager = async () => {
  try {
    const connectedClients = await WhatsAppClientModel.find({
      status: { $in: ['connected', 'initializing', 'qr_ready'] },
      isActive: true
    });

    console.log(`🔄 Restoring ${connectedClients.length} WhatsApp sessions...`);

    for (const client of connectedClients) {
      try {
        await createWhatsAppClient(client.clientId);
        // Small delay to avoid overwhelming the system
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`Error restoring client ${client.clientId}:`, err);
      }
    }
  } catch (err) {
    console.error('Error in initWhatsAppManager:', err);
  }
};

/**
 * Check if a client is currently connected
 */
const isClientConnected = (clientId) => {
  const wClient = activeClients.get(clientId);
  return !!wClient;
};

module.exports = {
  createWhatsAppClient,
  getClient,
  destroyClient,
  sendMessage,
  initWhatsAppManager,
  isClientConnected,
  activeClients
};
