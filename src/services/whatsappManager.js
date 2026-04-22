const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const { emitToClient } = require('../utils/socket');

// ─── Active clients map ───────────────────────────────────────────────────────
const activeClients = new Map();

// ─── Config ───────────────────────────────────────────────────────────────────
const parseEnvInt = (key, fallback) => {
  const v = parseInt(process.env[key] || `${fallback}`, 10);
  return Number.isFinite(v) ? v : fallback;
};
const getInitTimeoutMs    = () => parseEnvInt('WA_INIT_TIMEOUT_MS',              180000);
const getInitMaxRetries   = () => Math.max(0, parseEnvInt('WA_INIT_MAX_RETRIES',  3));
const getRetryBaseDelayMs = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_BASE_DELAY_MS', 3000));
const getRetryMaxDelayMs  = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_MAX_DELAY_MS',  15000));

// ─── Sessions directory ───────────────────────────────────────────────────────
// On a VPS: defaults to <project-root>/sessions — a persistent directory.
// With Docker: set SESSIONS_DIR=/app/sessions and mount it as a named volume.
const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : path.resolve(__dirname, '../../sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
console.log(`📁 Sessions dir: ${SESSIONS_DIR}`);

// ─── Chrome path ──────────────────────────────────────────────────────────────
const resolveBundledChromePath = () => {
  const root = path.resolve(__dirname, '../../.puppeteer/chrome');
  if (!fs.existsSync(root)) return null;
  const builds = fs.readdirSync(root).filter(n => n.startsWith('linux-')).sort();
  if (!builds.length) return null;
  const exe = path.join(root, builds[builds.length - 1], 'chrome-linux64', 'chrome');
  return fs.existsSync(exe) ? exe : null;
};

const getChromePath = () =>
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_BIN ||
  resolveBundledChromePath();

// ─── Session / lock helpers ───────────────────────────────────────────────────

const getProfileDir = (clientId) => {
  const primary = path.join(SESSIONS_DIR, `session-${clientId}`);
  const alt     = path.join(SESSIONS_DIR, clientId);
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(alt))     return alt;
  return primary;
};

/**
 * A valid session exists when the "Default" sub-dir is present.
 * (It holds IndexedDB / cookies / WhatsApp auth keys.)
 */
const sessionExistsOnDisk = (clientId) =>
  fs.existsSync(path.join(getProfileDir(clientId), 'Default'));

/**
 * Removes ONLY the Chromium lock files left after an unclean shutdown.
 *
 * Why this fixes the "profile in use" error on Docker deploy:
 *   SingletonLock is a symlink whose target encodes the hostname + pid.
 *   Every new Docker container gets a different hostname, so Chromium
 *   thinks the profile belongs to "another machine" and refuses to start.
 *   Deleting the lock files (NOT the session data) lets Chromium reuse
 *   the existing authenticated profile → no QR re-scan needed.
 */
const LOCK_FILES = [
  'SingletonLock', 'SingletonSocket', 'SingletonCookie',
  'lockfile', '.parentlock', 'DevToolsActivePort',
];

const clearChromiumLocks = (clientId) => {
  const profileDir = getProfileDir(clientId);
  if (!fs.existsSync(profileDir)) return;

  const searchDirs = [profileDir, path.join(profileDir, 'Default')];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of LOCK_FILES) {
      const p = path.join(dir, f);
      try {
        fs.lstatSync(p);          // catches dangling symlinks
        fs.rmSync(p, { force: true });
        console.log(`🔓 Removed lock: ${p}`);
      } catch (_) { /* doesn't exist — fine */ }
    }
  }
};

/** Completely wipes session data. Only used for forceReauth / sessionMissing. */
const clearClientSessionData = (clientId) => {
  const dir = getProfileDir(clientId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`🗑️  Cleared session for ${clientId}`);
    }
  } catch (e) {
    console.error(`Failed to clear session for ${clientId}:`, e.message);
  }
};

// ─── Retry helpers ────────────────────────────────────────────────────────────
const getRetryDelayMs = (attempt) =>
  Math.min(getRetryBaseDelayMs() * Math.pow(2, Math.max(0, attempt - 1)), getRetryMaxDelayMs());

const isRetryableError = (err) => {
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('timed out')              ||
    msg.includes('timeout')               ||
    msg.includes('target closed')         ||
    msg.includes('navigation')            ||
    msg.includes('browser')               ||
    msg.includes('websocket')             ||
    msg.includes('profile appears to be') ||
    msg.includes('singleton')             ||
    msg.includes('failed to launch')
  );
};

// ─── createWhatsAppClient ─────────────────────────────────────────────────────

/**
 * @param {string} clientId
 * @param {object} [opts]
 * @param {boolean} [opts.forceReauth=false]    – wipe session, force new QR
 * @param {boolean} [opts.sessionMissing=false] – no session on disk → new QR
 * @param {number}  [opts.attempt=1]            – internal retry counter
 */
const createWhatsAppClient = async (clientId, opts = {}) => {
  const { forceReauth = false, sessionMissing = false, attempt = 1 } = opts;
  const maxRetries = getInitMaxRetries();

  if (activeClients.has(clientId)) {
    console.log(`Client ${clientId} already active`);
    return activeClients.get(clientId);
  }

  console.log(`🔧 Init ${clientId} (attempt ${attempt}/${maxRetries + 1})`);

  if ((forceReauth || sessionMissing) && attempt === 1) {
    clearClientSessionData(clientId);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null, phone: '' }
    );
  } else {
    // Normal start or retry: remove stale lock files only, keep auth data intact
    clearChromiumLocks(clientId);
  }

  const chromePath = getChromePath();
  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    ],
  };
  if (chromePath) {
    puppeteerConfig.executablePath = chromePath;
    console.log(`🌐 Chrome: ${chromePath}`);
  }

  const wClient = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: SESSIONS_DIR }),
    puppeteer: puppeteerConfig,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
  });

  let initSettled      = false;
  let initTimeoutHandle = null;

  const settleInit = () => {
    if (initSettled) return;
    initSettled = true;
    if (initTimeoutHandle) clearTimeout(initTimeoutHandle);
  };

  const scheduleRetry = async ({ timedOut = false, err = null } = {}) => {
    if (initSettled) return;
    settleInit();
    activeClients.delete(clientId);
    try { await wClient.destroy(); } catch (_) {}

    const canRetry = attempt <= maxRetries && (timedOut || isRetryableError(err));

    if (canRetry) {
      const delay       = getRetryDelayMs(attempt);
      const nextAttempt = attempt + 1;
      console.warn(`♻️  Retrying ${clientId} in ${delay}ms (${nextAttempt}/${maxRetries + 1})`);
      await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'initializing', qrCode: null });
      emitToClient(clientId, 'init_retry', {
        clientId, attempt: nextAttempt, maxAttempts: maxRetries + 1,
        retryInMs: delay, reason: timedOut ? 'timeout' : (err?.message || 'error'),
      });
      setTimeout(() => {
        clearChromiumLocks(clientId);
        createWhatsAppClient(clientId, { attempt: nextAttempt }).catch(e =>
          console.error(`Retry failed for ${clientId}:`, e)
        );
      }, delay);
      return;
    }

    await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'disconnected', qrCode: null });
    const reason = timedOut ? 'timeout' : (err?.message || 'unknown');
    console.error(`❌ ${clientId} failed after ${attempt} attempt(s): ${reason}`);
    emitToClient(clientId, 'init_error', {
      clientId,
      message: `WhatsApp init failed for ${clientId}. Reason: ${reason}. Please reconnect from the dashboard.`,
    });
  };

  initTimeoutHandle = setTimeout(async () => {
    if (initSettled) return;
    console.error(`⏰ Init timeout for ${clientId}`);
    await scheduleRetry({ timedOut: true });
  }, getInitTimeoutMs());

  // ── Events ──────────────────────────────────────────────────────────────────

  wClient.on('qr', async (qr) => {
    settleInit();
    console.log(`📱 QR for ${clientId}`);
    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'qr_ready', qrCode: qrDataUrl });
      emitToClient(clientId, 'qr', { clientId, qr: qrDataUrl });
    } catch (e) { console.error(`QR error for ${clientId}:`, e); }
  });

  wClient.on('ready', async () => {
    settleInit();
    const phone = wClient.info?.wid?.user || '';
    console.log(`✅ Ready: ${clientId} (${phone})`);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'connected', qrCode: null, phone, lastConnected: new Date() }
    );
    emitToClient(clientId, 'ready', { clientId, phone });
  });

  wClient.on('auth_failure', async (msg) => {
    settleInit();
    console.error(`🔐 Auth failure for ${clientId}:`, msg);
    activeClients.delete(clientId);
    await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'auth_failure', qrCode: null });
    emitToClient(clientId, 'auth_failure', { clientId, message: msg });
    // Auto-recover: wipe corrupted session → generate fresh QR
    console.log(`🔄 Auto-recovering ${clientId} after auth_failure...`);
    clearClientSessionData(clientId);
    setTimeout(() =>
      createWhatsAppClient(clientId, { forceReauth: true }).catch(e =>
        console.error(`Auth-failure recovery failed for ${clientId}:`, e)
      ), 3000
    );
  });

  wClient.on('disconnected', async (reason) => {
    settleInit();
    console.log(`🔌 ${clientId} disconnected: ${reason}`);
    activeClients.delete(clientId);
    await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'disconnected', qrCode: null });
    emitToClient(clientId, 'disconnected', { clientId, reason });
  });

  wClient.on('message', async (msg) => {
    try {
      const dbClient = await WhatsAppClientModel.findOne({ clientId });
      if (!dbClient) return;
      const bodyText    = typeof msg.body === 'string' ? msg.body.trim() : '';
      const captionText = typeof msg?._data?.caption === 'string' ? msg._data.caption.trim() : '';
      const messageType = msg?.type || (msg?.hasMedia ? 'media' : 'unknown');
      const logText     = bodyText || captionText || `[${messageType}]`;
      await MessageLog.create({
        userId: dbClient.userId, clientId: dbClient._id,
        phone: (msg.from || '').replace('@c.us', ''),
        message: logText, direction: 'incoming', status: 'received',
        whatsappMessageId: msg?.id?._serialized,
      });
      emitToClient(clientId, 'incoming-message', {
        clientId, from: msg.from,
        body: bodyText || captionText || '',
        type: messageType, timestamp: msg.timestamp,
      });
    } catch (e) { console.error('Error saving incoming message:', e); }
  });

  await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'initializing' });
  activeClients.set(clientId, wClient);
  wClient.initialize().catch(async (err) => {
    console.error(`Failed to init ${clientId}:`, err.message);
    await scheduleRetry({ err });
  });

  return wClient;
};

// ─── Public API ───────────────────────────────────────────────────────────────

const getClient         = (clientId) => activeClients.get(clientId);
const isClientConnected = (clientId) => activeClients.has(clientId);

const destroyClient = async (clientId) => {
  const wClient = activeClients.get(clientId);
  if (wClient) {
    try { await wClient.destroy(); } catch (e) {
      console.error(`Destroy error for ${clientId}:`, e);
    }
    activeClients.delete(clientId);
  }
  await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'disconnected', qrCode: null });
};

/**
 * Gracefully destroys all active clients.
 * Called from server.js on SIGTERM / SIGINT.
 */
const destroyAllClients = async () => {
  const ids = [...activeClients.keys()];
  console.log(`🧹 Destroying ${ids.length} active WhatsApp client(s) before shutdown...`);
  await Promise.allSettled(ids.map(id => destroyClient(id)));
};

const sendMessage = async (clientId, phone, message) => {
  const wClient = activeClients.get(clientId);
  if (!wClient) throw new Error(`No active client for ${clientId}`);
  const dbClient = await WhatsAppClientModel.findOne({ clientId });
  if (!dbClient || dbClient.status !== 'connected') {
    throw new Error(`Client ${clientId} is not connected`);
  }
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  const result = await wClient.sendMessage(chatId, message);
  await WhatsAppClientModel.findOneAndUpdate({ clientId }, { $inc: { messagesSent: 1 } });
  return result;
};

/**
 * Called on server startup. Restores all previously active sessions.
 *
 * Decision table:
 * ┌─────────────────────────────────────┬───────────────────────────────────┐
 * │ DB status                           │ Action                            │
 * ├─────────────────────────────────────┼───────────────────────────────────┤
 * │ connected  + session on disk        │ clearLocks → silent reconnect     │
 * │ connected  + NO session on disk     │ clearData  → fresh QR             │
 * │ qr_ready / initializing             │ clearLocks → restart (new QR)     │
 * │ auth_failure                        │ clearData  → fresh QR             │
 * └─────────────────────────────────────┴───────────────────────────────────┘
 *
 * NOTE: Uses separate queries per status group instead of $in, because the
 * WhatsAppClient model's buildFilter only supports plain string equality for
 * the status field.  The $in support was added to the model as well, but these
 * explicit queries make the restore logic self-contained and safe regardless.
 */
const initWhatsAppManager = async () => {
  try {
    // Fetch each group separately — safe even without $in support in the model
    const [connected, inProgress, authFailed] = await Promise.all([
      WhatsAppClientModel.find({ status: 'connected',    isActive: true }),
      WhatsAppClientModel.find({ status: 'initializing', isActive: true }),
      WhatsAppClientModel.find({ status: 'auth_failure', isActive: true }),
    ]);
    // qr_ready clients also need a restart
    const qrReady = await WhatsAppClientModel.find({ status: 'qr_ready', isActive: true });

    const allClients = [...connected, ...inProgress, ...qrReady, ...authFailed];
    console.log(`🔄 Restoring ${allClients.length} WhatsApp client(s)...`);

    for (const client of allClients) {
      try {
        const { clientId, status } = client;

        if (status === 'auth_failure') {
          console.log(`🔐 ${clientId}: auth_failure → clearing session, fresh QR`);
          clearClientSessionData(clientId);
          await createWhatsAppClient(clientId, { forceReauth: true });

        } else if (status === 'connected' && !sessionExistsOnDisk(clientId)) {
          console.log(`⚠️  ${clientId}: was connected but session missing on disk → fresh QR`);
          await createWhatsAppClient(clientId, { sessionMissing: true });

        } else if (status === 'connected') {
          console.log(`✅ ${clientId}: session found on disk → restoring silently (no QR needed)`);
          await createWhatsAppClient(clientId);

        } else {
          // initializing / qr_ready — these never finished, restart cleanly
          console.log(`🔁 ${clientId}: was "${status}" → restarting for fresh QR`);
          clearChromiumLocks(clientId);
          await createWhatsAppClient(clientId);
        }

        // Stagger client starts to avoid CPU/RAM spike
        await new Promise(r => setTimeout(r, 2500));
      } catch (err) {
        console.error(`Error restoring ${client.clientId}:`, err);
      }
    }

    console.log('✅ WhatsApp manager ready.');
  } catch (err) {
    console.error('initWhatsAppManager error:', err);
  }
};

module.exports = {
  createWhatsAppClient,
  getClient,
  destroyClient,
  destroyAllClients,
  sendMessage,
  initWhatsAppManager,
  isClientConnected,
  activeClients,
};
