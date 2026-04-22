const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const { emitToClient } = require('../utils/socket');

// ─── Active clients map ───────────────────────────────────────────────────────
const activeClients = new Map();

// ─── Config helpers ───────────────────────────────────────────────────────────
const parseEnvInt = (key, fallback) => {
  const value = parseInt(process.env[key] || `${fallback}`, 10);
  return Number.isFinite(value) ? value : fallback;
};
const getInitTimeoutMs    = () => parseEnvInt('WA_INIT_TIMEOUT_MS',             180000);
const getInitMaxRetries   = () => Math.max(0, parseEnvInt('WA_INIT_MAX_RETRIES', 3));
const getRetryBaseDelayMs = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_BASE_DELAY_MS', 3000));
const getRetryMaxDelayMs  = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_MAX_DELAY_MS',  15000));

// ─── Sessions directory ───────────────────────────────────────────────────────
// MUST be a Docker named-volume path or a persistent VPS directory.
// Set SESSIONS_DIR in your .env / docker-compose to override.
const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : path.resolve(__dirname, '../../sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
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

/** Returns the LocalAuth profile root directory for a clientId */
const getProfileDir = (clientId) => {
  const primary = path.join(SESSIONS_DIR, `session-${clientId}`);
  const alt     = path.join(SESSIONS_DIR, clientId);
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(alt))     return alt;
  return primary;
};

/**
 * A valid session exists when the "Default" sub-directory is present.
 * (That directory holds IndexedDB / cookies / auth keys.)
 */
const sessionExistsOnDisk = (clientId) =>
  fs.existsSync(path.join(getProfileDir(clientId), 'Default'));

/**
 * Removes ONLY the Chromium lock files that are left behind after an unclean
 * shutdown (SIGTERM, OOM kill, Docker stop, new deploy).
 *
 * Key insight: SingletonLock is a symlink whose target is "<hostname>-<pid>".
 * When Docker creates a new container the hostname changes, so Chromium sees
 * the old symlink as belonging to a "different machine" and refuses to start.
 * Deleting just these lock files — NOT the session data — lets Chromium reuse
 * the existing authenticated profile without any QR re-scan.
 */
const LOCK_FILES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
  '.parentlock',
  'DevToolsActivePort',
];

const clearChromiumLocks = (clientId) => {
  const profileDir = getProfileDir(clientId);
  if (!fs.existsSync(profileDir)) return;

  // Locks appear in both the profile root AND the Default sub-directory
  const searchDirs = [profileDir, path.join(profileDir, 'Default')];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const lockFile of LOCK_FILES) {
      const lockPath = path.join(dir, lockFile);
      try {
        fs.lstatSync(lockPath); // catches dangling symlinks too
        fs.rmSync(lockPath, { force: true });
        console.log(`🔓 Removed lock: ${lockPath}`);
      } catch (_) { /* file does not exist — nothing to do */ }
    }
  }
};

/** Completely wipes session data (only used for forceReauth / sessionMissing) */
const clearClientSessionData = (clientId) => {
  const profileDir = getProfileDir(clientId);
  try {
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
      console.log(`🗑️  Cleared session data for ${clientId}`);
    }
  } catch (err) {
    console.error(`Failed to clear session for ${clientId}:`, err.message);
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
    msg.includes('profile appears to be') ||  // SingletonLock conflict
    msg.includes('singleton')             ||  // SingletonLock conflict
    msg.includes('failed to launch')          // generic Chromium launch failure
  );
};

// ─── Core: createWhatsAppClient ───────────────────────────────────────────────

/**
 * @param {string} clientId
 * @param {object} [opts]
 * @param {boolean} [opts.forceReauth=false]    – wipe session, force new QR
 * @param {boolean} [opts.sessionMissing=false] – session files gone, go to QR
 * @param {number}  [opts.attempt=1]            – current retry (internal use)
 */
const createWhatsAppClient = async (clientId, opts = {}) => {
  const { forceReauth = false, sessionMissing = false, attempt = 1 } = opts;
  const maxRetries = getInitMaxRetries();

  if (activeClients.has(clientId)) {
    console.log(`Client ${clientId} already active`);
    return activeClients.get(clientId);
  }

  console.log(`🔧 Init ${clientId} (attempt ${attempt}/${maxRetries + 1})`);

  // ── Handle session data ────────────────────────────────────────────────────
  if ((forceReauth || sessionMissing) && attempt === 1) {
    // Full wipe — user must scan a new QR
    clearClientSessionData(clientId);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null, phone: '' }
    );
  } else {
    // Normal start or retry: remove stale lock files only, keep auth data
    clearChromiumLocks(clientId);
  }

  // ── Puppeteer config ───────────────────────────────────────────────────────
  const chromePath = getChromePath();
  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
    ],
  };
  if (chromePath) {
    puppeteerConfig.executablePath = chromePath;
    console.log(`🌐 Chrome: ${chromePath}`);
  }

  // ── Build Client ───────────────────────────────────────────────────────────
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

  // ── Retry / give-up ────────────────────────────────────────────────────────
  const scheduleRetry = async ({ timedOut = false, err = null } = {}) => {
    if (initSettled) return;
    settleInit();
    activeClients.delete(clientId);
    try { await wClient.destroy(); } catch (_) {}

    const canRetry = attempt <= maxRetries && (timedOut || isRetryableError(err));

    if (canRetry) {
      const delay       = getRetryDelayMs(attempt);
      const nextAttempt = attempt + 1;
      console.warn(`♻️  Retrying ${clientId} in ${delay}ms (attempt ${nextAttempt}/${maxRetries + 1})`);

      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { status: 'initializing', qrCode: null }
      );
      emitToClient(clientId, 'init_retry', {
        clientId, attempt: nextAttempt,
        maxAttempts: maxRetries + 1, retryInMs: delay,
        reason: timedOut ? 'timeout' : (err?.message || 'error'),
      });

      setTimeout(() => {
        clearChromiumLocks(clientId); // clear locks before each retry
        createWhatsAppClient(clientId, { attempt: nextAttempt }).catch(e =>
          console.error(`Retry failed for ${clientId}:`, e)
        );
      }, delay);
      return;
    }

    // All retries exhausted
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null }
    );
    const reason = timedOut ? 'timeout' : (err?.message || 'init failed');
    console.error(`❌ ${clientId} failed after ${attempt} attempt(s): ${reason}`);
    emitToClient(clientId, 'init_error', {
      clientId,
      message: `WhatsApp init failed for ${clientId}. Reason: ${reason}. Please reconnect from the dashboard.`,
    });
  };

  // ── Timeout watchdog ───────────────────────────────────────────────────────
  initTimeoutHandle = setTimeout(async () => {
    if (initSettled) return;
    console.error(`⏰ Init timeout for ${clientId}`);
    await scheduleRetry({ timedOut: true });
  }, getInitTimeoutMs());

  // ── Events ─────────────────────────────────────────────────────────────────
  wClient.on('qr', async (qr) => {
    settleInit();
    console.log(`📱 QR for ${clientId}`);
    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { status: 'qr_ready', qrCode: qrDataUrl }
      );
      emitToClient(clientId, 'qr', { clientId, qr: qrDataUrl });
    } catch (e) {
      console.error(`QR error for ${clientId}:`, e);
    }
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
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'auth_failure', qrCode: null }
    );
    emitToClient(clientId, 'auth_failure', { clientId, message: msg });

    // Auto-recover: wipe corrupted session → fresh QR
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
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null }
    );
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
    } catch (e) {
      console.error('Error saving incoming message:', e);
    }
  });

  // ── Launch ─────────────────────────────────────────────────────────────────
  await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'initializing' });
  activeClients.set(clientId, wClient);
  wClient.initialize().catch(async (err) => {
    console.error(`Failed to init ${clientId}:`, err.message);
    await scheduleRetry({ err });
  });

  return wClient;
};

// ─── Public API ───────────────────────────────────────────────────────────────

const getClient        = (clientId) => activeClients.get(clientId);
const isClientConnected = (clientId) => activeClients.has(clientId);

const destroyClient = async (clientId) => {
  const wClient = activeClients.get(clientId);
  if (wClient) {
    try { await wClient.destroy(); } catch (e) {
      console.error(`Destroy error for ${clientId}:`, e);
    }
    activeClients.delete(clientId);
  }
  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { status: 'disconnected', qrCode: null }
  );
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
 * Called on server startup. Restores all previously active WhatsApp sessions.
 *
 * Decision table:
 * ┌────────────────────────────────────┬─────────────────────────────────────┐
 * │ DB status                          │ Action                              │
 * ├────────────────────────────────────┼─────────────────────────────────────┤
 * │ connected  + session on disk       │ clearLocks only → silent reconnect  │
 * │ connected  + NO session on disk    │ clearData → fresh QR                │
 * │ qr_ready / initializing            │ clearLocks → restart (new QR)       │
 * │ auth_failure                       │ clearData → fresh QR                │
 * └────────────────────────────────────┴─────────────────────────────────────┘
 */
const initWhatsAppManager = async () => {
  try {
    const clients = await WhatsAppClientModel.find({
      status: { $in: ['connected', 'initializing', 'qr_ready', 'auth_failure'] },
      isActive: true,
    });

    console.log(`🔄 Restoring ${clients.length} WhatsApp client(s)...`);

    for (const client of clients) {
      try {
        const { clientId, status } = client;

        if (status === 'auth_failure') {
          console.log(`🔐 ${clientId}: auth_failure → fresh QR`);
          clearClientSessionData(clientId);
          await createWhatsAppClient(clientId, { forceReauth: true });

        } else if (status === 'connected' && !sessionExistsOnDisk(clientId)) {
          console.log(`⚠️  ${clientId}: session missing on disk → fresh QR`);
          await createWhatsAppClient(clientId, { sessionMissing: true });

        } else if (status === 'connected') {
          console.log(`✅ ${clientId}: restoring session silently`);
          // clearChromiumLocks is called automatically inside createWhatsAppClient
          await createWhatsAppClient(clientId);

        } else {
          console.log(`🔁 ${clientId}: was "${status}" → restarting`);
          clearChromiumLocks(clientId);
          await createWhatsAppClient(clientId);
        }

        await new Promise(r => setTimeout(r, 2500)); // stagger to avoid CPU spike
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
  sendMessage,
  initWhatsAppManager,
  isClientConnected,
  activeClients,
};
