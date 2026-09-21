require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { testConnection } = require('./db/mysql');
const { alignDiagramSchema } = require('./db/alignDiagramSchema');

const authRoutes     = require('./routes/auth');
const clientRoutes   = require('./routes/clients');
const messageRoutes  = require('./routes/messages');
const otpRoutes      = require('./routes/otp');
const logRoutes      = require('./routes/logs');
const adminRoutes    = require('./routes/admin');

const TokenSession        = require('./models/TokenSession');
const User                = require('./models/User');
const UserSource          = require('./models/UserSource');
const Plan                = require('./models/Plan');
const WhatsAppClientModel = require('./models/WhatsAppClient');
const MessageLog          = require('./models/MessageLog');
const { isClientQrTokenValid } = require('./utils/qrShare');

const { initWhatsAppManager, destroyAllClients, requestQrForClient } = require('./services/whatsappManager');
const { setSocketIO } = require('./utils/socket');

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const app    = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Service-Key', 'X-Service-Name', 'X-Otp-Source'],
  credentials: false,
  optionsSuccessStatus: 204,
};

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    methods: ['GET', 'POST'],
  },
});

setSocketIO(io);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/auth',      authRoutes);
app.use('/api/clients',   clientRoutes);
app.use('/api/messages',  messageRoutes);
app.use('/api/otp',       otpRoutes);
app.use('/api/logs',      logRoutes);
app.use('/api/admin',     adminRoutes);

app.get('/api/health', (_req, res) => {
  const serviceKey = Boolean(String(process.env.OTP_SERVICE_SECRET || '').trim());
  const jwtAuth = Boolean(String(process.env.JWT_SECRET || '').trim());
  const { isSmtpConfigured } = require('./utils/smtp');
  return res.json({
    status: 'ok',
    timestamp: new Date(),
    otp: {
      configured: serviceKey || jwtAuth,
      serviceKeyConfigured: serviceKey,
      jwtAuthAvailable: jwtAuth,
      endpoint: 'POST /api/otp/send',
      statsEndpoint: 'GET /api/otp/stats',
      source: 'Source is optional. Send it in JSON body or header X-Service-Name only if you want stats split by Laravel app. Billing uses the assigned number plan.',
      auth: [
        ...(jwtAuth ? ['Authorization: Bearer <WHATSAPP_NODE_TOKEN>'] : []),
        ...(serviceKey ? ['X-Service-Key: <OTP_SERVICE_SECRET>'] : [])
      ]
    },
    disconnectEmail: {
      enabled: String(process.env.WHATSAPP_DISCONNECT_EMAIL_ENABLED || 'true').toLowerCase() !== 'false',
      smtpConfigured: isSmtpConfigured()
    }
  });
});

const getQrCodeBuffer = (dataUrl) => {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return null;
  return Buffer.from(match[1], 'base64');
};

// Public QR page (token-protected)
app.get('/public/qr/:clientId([^\\.]+)', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!isClientQrTokenValid(req.params.clientId, token)) {
      return res.status(403).send('Invalid or missing QR share token');
    }
    const existing = await WhatsAppClientModel.findOne({ clientId: req.params.clientId, isActive: true });
    if (!existing) return res.status(404).send('Client not found');

    const qrRequest = await requestQrForClient(req.params.clientId);
    const client = await WhatsAppClientModel.findOne({ clientId: req.params.clientId, isActive: true }) || existing;
    const qrCode  = client.qrCode || '';
    const hasQr   = qrCode.startsWith('data:image/png;base64,');
    const alreadyConnected = Boolean(qrRequest.connected || client.status === 'connected');
    const paused = Boolean(qrRequest.paused);
    const bootWait = Boolean(qrRequest.boot);
    const generating = !hasQr && !alreadyConnected && !paused && !bootWait && (qrRequest.started || qrRequest.active || client.status === 'initializing' || client.status === 'qr_ready');
    const retrySec = Math.ceil((qrRequest.retryInMs || 0) / 1000);
    const qrHtml  = alreadyConnected
      ? '<p style="font:500 16px system-ui;color:#065f46;">Connected. You can close this page.</p>'
      : paused
        ? `<p style="font:500 16px system-ui;color:#92400e;">QR timed out to free memory. Wait ${retrySec || 60}s, then reload — or click Connect in the dashboard.</p>`
        : bootWait
          ? '<p style="font:500 16px system-ui;color:#374151;">Server is restoring other WhatsApp numbers. This page will retry shortly…</p>'
          : hasQr
            ? `<img src="${qrCode}" alt="WhatsApp QR" style="width:320px;height:320px;border:1px solid #e5e7eb;border-radius:12px;padding:8px;background:#fff;" />`
            : generating
              ? '<p style="font:500 16px system-ui;color:#374151;">Generating a fresh QR code… keep this page open.</p>'
              : '<p style="font:500 16px system-ui;color:#374151;">Waiting for a fresh QR code...</p>';
    const hint = alreadyConnected
      ? '<p style="font:400 13px system-ui;color:#6b7280;margin:16px 0 0;">WhatsApp is linked. Auto-refresh is stopped.</p>'
      : paused
        ? '<p style="font:400 13px system-ui;color:#6b7280;margin:16px 0 0;">Leaving Open/Share open without scanning was restarting Chromium in a loop and starving other numbers.</p>'
        : hasQr
          ? '<p style="font:400 13px system-ui;color:#6b7280;margin:16px 0 0;">Open WhatsApp → Linked devices → Link a device, then scan this code.</p>'
          : '<p style="font:400 13px system-ui;color:#6b7280;margin:16px 0 0;">This page refreshes automatically.</p>';
    const refreshMeta = alreadyConnected
      ? ''
      : paused
        ? `<meta http-equiv="refresh" content="${Math.max(30, Math.min(120, retrySec || 60))}">`
        : bootWait
          ? '<meta http-equiv="refresh" content="10">'
          : `<meta http-equiv="refresh" content="${hasQr ? 8 : 4}">`;

    return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp QR</title>
    ${refreshMeta}
  </head>
  <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f3f4f6;">
    <main style="text-align:center;padding:24px;">
      <h1 style="font:600 20px system-ui;margin:0 0 12px;color:#111827;">${alreadyConnected ? 'WhatsApp connected' : (paused ? 'QR paused' : 'Scan WhatsApp QR')}</h1>
      ${qrHtml}
      ${hint}
    </main>
  </body>
</html>`);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// Direct QR image (PNG)
app.get('/public/qr/:clientId.png', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!isClientQrTokenValid(req.params.clientId, token)) {
      return res.status(403).send('Invalid or missing QR share token');
    }
    const existing = await WhatsAppClientModel.findOne({ clientId: req.params.clientId, isActive: true });
    if (!existing) return res.status(404).send('Client not found');

    const qrRequest = await requestQrForClient(req.params.clientId);
    if (qrRequest.connected) {
      return res.status(410).send('Already connected');
    }
    const client = await WhatsAppClientModel.findOne({ clientId: req.params.clientId, isActive: true }) || existing;

    const imageBuffer = getQrCodeBuffer(client.qrCode);
    if (!imageBuffer) return res.status(404).send('QR not ready');

    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(imageBuffer);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on('join-client-room', (clientId) => {
    if (!clientId) return;
    socket.join(`client-${clientId}`);
  });
  socket.on('leave-client-room', (clientId) => {
    if (!clientId) return;
    socket.leave(`client-${clientId}`);
  });
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`🛑 Received ${signal}. Preparing graceful shutdown (WhatsApp sessions will be restored on next boot)...`);

  server.close(() => {
    console.log('✅ HTTP server closed.');
  });

  try {
    await destroyAllClients();
  } catch (err) {
    console.error('Error while destroying WhatsApp clients:', err.message);
  }

  console.log('✅ WhatsApp sessions preserved. Exiting.');
  process.exit(0);

  // Force exit after 30 s if something hangs
  setTimeout(() => {
    console.error('⚠️  Forced exit after timeout.');
    process.exit(1);
  }, 30000).unref();
};
// ─── Graceful shutdown ────────────────────────────────────────────────────────`
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─── Startup ──────────────────────────────────────────────────────────────────
if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
  console.error('❌ Missing MySQL env variables (DB_HOST, DB_USER, DB_NAME)');
  process.exit(1);
}

testConnection()
  .then(async (ok) => {
    if (!ok) throw new Error('MySQL ping failed');
    await alignDiagramSchema();
    await TokenSession.init();
    await User.ensureAuthTokenColumn();
    await Plan.ensureTable();
    await WhatsAppClientModel.ensurePoolColumns();
    const App = require('./models/App');
    await App.ensureTable();
    await UserSource.ensureTable();
    await MessageLog.ensureSourceColumn();
    console.log('✅ MySQL connected');

    server.listen(process.env.PORT || 5000, () => {
      console.log(`🚀 Server running on port ${process.env.PORT || 5000}`);
    });

    initWhatsAppManager().catch((err) => {
      console.error('WhatsApp manager init error:', err);
    });
  })
  .catch(err => {
    console.error('❌ MySQL connection error:', err);
    process.exit(1);
  });

module.exports = { app, io };
