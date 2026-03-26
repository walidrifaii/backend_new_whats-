require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { testConnection } = require('./db/mysql');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const campaignRoutes = require('./routes/campaigns');
const contactRoutes = require('./routes/contacts');
const messageRoutes = require('./routes/messages');
const logRoutes = require('./routes/logs');
const adminRoutes = require('./routes/admin');
const WhatsAppClientModel = require('./models/WhatsAppClient');
const { isClientQrTokenValid } = require('./utils/qrShare');

const { initWhatsAppManager } = require('./services/whatsappManager');
const { setSocketIO } = require('./utils/socket');

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server, curl, and same-origin requests with no Origin header.
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 204
};

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    methods: ['GET', 'POST']
  }
});

setSocketIO(io);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

const getQrCodeBuffer = (dataUrl) => {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return null;
  return Buffer.from(match[1], 'base64');
};

// Public QR page (token-protected) for easy sharing.
app.get('/public/qr/:clientId([^\\.]+)', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!isClientQrTokenValid(req.params.clientId, token)) {
      return res.status(403).send('Invalid or missing QR share token');
    }

    const client = await WhatsAppClientModel.findOne({
      clientId: req.params.clientId,
      isActive: true
    });
    if (!client) return res.status(404).send('Client not found');

    const qrCode = client.qrCode || '';
    const hasQr = qrCode.startsWith('data:image/png;base64,');
    const qrImageHtml = hasQr
      ? `<img src="${qrCode}" alt="WhatsApp QR" style="width:320px;height:320px;border:1px solid #e5e7eb;border-radius:12px;padding:8px;background:#fff;" />`
      : '<p style="font:500 16px system-ui;color:#374151;">Waiting for a fresh QR code...</p>';

    return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp QR</title>
    <meta http-equiv="refresh" content="8">
  </head>
  <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f3f4f6;">
    <main style="text-align:center;padding:24px;">
      <h1 style="font:600 20px system-ui;margin:0 0 12px;color:#111827;">Scan WhatsApp QR</h1>
      ${qrImageHtml}
    </main>
  </body>
</html>`);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// Direct QR image endpoint (PNG only), useful when you need image-only URL.
app.get('/public/qr/:clientId.png', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!isClientQrTokenValid(req.params.clientId, token)) {
      return res.status(403).send('Invalid or missing QR share token');
    }

    const client = await WhatsAppClientModel.findOne({
      clientId: req.params.clientId,
      isActive: true
    });
    if (!client) return res.status(404).send('Client not found');

    const imageBuffer = getQrCodeBuffer(client.qrCode);
    if (!imageBuffer) return res.status(404).send('QR not ready');

    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(imageBuffer);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on('join-client-room', (clientId) => {
    socket.join(`client-${clientId}`);
    console.log(`Socket ${socket.id} joined room client-${clientId}`);
  });
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// MySQL connection
if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
  console.error('❌ Missing MySQL env variables (DB_HOST, DB_USER, DB_NAME)');
  process.exit(1);
}

testConnection()
  .then((ok) => {
    if (!ok) throw new Error('MySQL ping failed');
    console.log('✅ MySQL connected');
    initWhatsAppManager();
    server.listen(process.env.PORT || 5000, () => {
      console.log(`🚀 Server running on port ${process.env.PORT || 5000}`);
    });
  })
  .catch(err => {
    console.error('❌ MySQL connection error:', err);
    process.exit(1);
  });

module.exports = { app, io };
