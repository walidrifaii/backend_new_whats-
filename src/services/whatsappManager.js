const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const { emitToClient } = require('../utils/socket');
const { notifyWhatsAppDisconnected } = require('./disconnectNotifier');

// ─── Active clients map ───────────────────────────────────────────────────────
const activeClients = new Map();
/** Clients being stopped for deploy/restart — keep DB `connected` + session on disk */
const clientsPreservingSession = new Set();
/** Manual dashboard disconnect — do not email the user */
const clientsSkippingDisconnectEmail = new Set();

// Per-client QR state — stuck unauthenticated clients keep Chromium alive and can OOM the server.
const qrMeta = new Map();
/** Prevent overlapping createWhatsAppClient / Chromium for the same clientId */
const initializingClients = new Set();
const clientInitChains = new Map();
const scheduledRetryTimers = new Map();
/** After QR abandon, block auto re-init until user explicitly resets */
const qrBlockedUntil = new Map();

// ─── Config ───────────────────────────────────────────────────────────────────
const parseEnvInt = (key, fallback) => {
  const v = parseInt(process.env[key] || `${fallback}`, 10);
  return Number.isFinite(v) ? v : fallback;
};
const getInitTimeoutMs        = () => parseEnvInt('WA_INIT_TIMEOUT_MS',              180000);
const getInitMaxRetries       = () => Math.max(0, parseEnvInt('WA_INIT_MAX_RETRIES',  1));
const getRetryBaseDelayMs     = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_BASE_DELAY_MS', 3000));
const getRetryMaxDelayMs      = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_MAX_DELAY_MS',  15000));
const getQrThrottleMs         = () => Math.max(5000, parseEnvInt('WA_QR_THROTTLE_MS', 20000));
// Backup safety net — primary stop is WA_QR_MAX_REFRESHES (default: 5 displayed QR codes).
const getQrPendingTimeoutMs   = () => Math.max(60000, parseEnvInt('WA_QR_PENDING_TIMEOUT_MS', 180000));
const getQrMaxRefreshes       = () => Math.max(3, parseEnvInt('WA_QR_MAX_REFRESHES', 5));
const getQrBlockMs            = () => Math.max(60000, parseEnvInt('WA_QR_BLOCK_MS', 300000));
const getRestoreBatchSize     = () => Math.max(1, parseEnvInt('WA_RESTORE_BATCH_SIZE', 1));
const getRestoreBatchDelayMs  = () => Math.max(1000, parseEnvInt('WA_RESTORE_BATCH_DELAY_MS', 5000));
const getBootRestoreDelayMs   = () => Math.max(0, parseEnvInt('WA_BOOT_RESTORE_DELAY_MS', 20000));
const getLockRetryDelayMs     = () => Math.max(500, parseEnvInt('WA_LOCK_RETRY_DELAY_MS', 2000));
const getSendMaxRetries       = () => Math.max(1, parseEnvInt('WA_SEND_MAX_RETRIES', 4));
const getSendReadyWaitMs      = () => Math.max(5000, parseEnvInt('WA_SEND_READY_WAIT_MS', 90000));

// ─── Sessions directory ───────────────────────────────────────────────────────
// On a VPS: defaults to <project-root>/sessions — a persistent directory.
// With Docker: set SESSIONS_DIR=/app/sessions and mount it as a named volume.
const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : path.resolve(__dirname, '../../sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
console.log(`📁 Sessions dir: ${SESSIONS_DIR}`);

const RESTORE_MANIFEST_PATH = path.join(SESSIONS_DIR, '.restore-manifest.json');
const RESTORE_MANIFEST_TTL_MS = 30 * 60 * 1000;

const writeRestoreManifest = (clientIds) => {
  if (!clientIds.length) return;
  try {
    fs.writeFileSync(
      RESTORE_MANIFEST_PATH,
      JSON.stringify({ at: Date.now(), clientIds: [...new Set(clientIds)] }),
      'utf8'
    );
    console.log(`💾 Wrote restore manifest for ${clientIds.length} client(s)`);
  } catch (e) {
    console.warn('Could not write restore manifest:', e.message);
  }
};

const readRestoreManifest = () => {
  try {
    if (!fs.existsSync(RESTORE_MANIFEST_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(RESTORE_MANIFEST_PATH, 'utf8'));
    if (!data?.clientIds?.length || !data.at) return null;
    if (Date.now() - data.at > RESTORE_MANIFEST_TTL_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
};

const clearRestoreManifest = () => {
  try {
    if (fs.existsSync(RESTORE_MANIFEST_PATH)) fs.rmSync(RESTORE_MANIFEST_PATH, { force: true });
  } catch (_) {}
};

const shouldKeepConnectedOnDisconnect = (clientId) => {
  if (clientsPreservingSession.has(clientId)) return true;
  const manifest = readRestoreManifest();
  return Boolean(manifest?.clientIds?.includes(clientId));
};

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const sessionExistsOnDisk = (clientId) => {
  const profileDir = getProfileDir(clientId);
  if (fs.existsSync(path.join(profileDir, 'Default'))) return true;
  if (fs.existsSync(path.join(profileDir, '.wwebjs_auth'))) return true;
  const nested = path.join(SESSIONS_DIR, `session-${clientId}`);
  if (fs.existsSync(path.join(nested, '.wwebjs_auth'))) return true;
  if (fs.existsSync(path.join(nested, 'Default'))) return true;
  return false;
};

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

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!LOCK_FILES.includes(ent.name)) continue;
      try {
        fs.lstatSync(p);
        fs.rmSync(p, { force: true });
        console.log(`🔓 Removed lock: ${p}`);
      } catch (_) { /* doesn't exist — fine */ }
    }
  };

  walk(profileDir);
};

const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '');

const isProfileLockError = (err) => {
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('profile appears to be') ||
    msg.includes('singleton')             ||
    msg.includes('code: 21')
  );
};

/** Completely wipes session data. Only used for forceReauth / sessionMissing / LOGOUT. */
const clearClientSessionData = (clientId) => {
  clearChromiumLocks(clientId);
  const dirs = [
    getProfileDir(clientId),
    path.join(SESSIONS_DIR, clientId),
    path.join(SESSIONS_DIR, `session-${clientId}`)
  ].filter((d, i, arr) => fs.existsSync(d) && arr.indexOf(d) === i);

  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      console.log(`🗑️  Cleared session for ${clientId}`);
    } catch (e) {
      console.error(`Failed to clear session for ${clientId}:`, e.message);
    }
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
    msg.includes('execution context')     ||
    msg.includes('browser')               ||
    msg.includes('websocket')             ||
    msg.includes('profile appears to be') ||
    msg.includes('singleton')             ||
    msg.includes('failed to launch')      ||
    msg.includes('onqrchangedevent')
  );
};

const isLogoutDisconnect = (reason) => {
  const r = String(reason || '').toUpperCase();
  return r.includes('LOGOUT') || r.includes('UNPAIRED') || r.includes('UNAUTHORIZED');
};

const cancelScheduledRetry = (clientId) => {
  const timer = scheduledRetryTimers.get(clientId);
  if (timer) {
    clearTimeout(timer);
    scheduledRetryTimers.delete(clientId);
  }
};

const finishInitializing = (clientId) => {
  initializingClients.delete(clientId);
  cancelScheduledRetry(clientId);
};

const isQrBlocked = (clientId) => {
  const until = qrBlockedUntil.get(clientId) || 0;
  return Date.now() < until;
};

const blockQrReinit = (clientId) => {
  qrBlockedUntil.set(clientId, Date.now() + getQrBlockMs());
};

const clearQrMeta = (clientId) => {
  const meta = qrMeta.get(clientId);
  if (meta?.pendingTimer) clearTimeout(meta.pendingTimer);
  qrMeta.delete(clientId);
};

const getQrMeta = (clientId) => {
  if (!qrMeta.has(clientId)) {
    qrMeta.set(clientId, {
      refreshCount: 0,
      lastHandledAt: 0,
      pendingTimer: null,
      handling: false,
      releasing: false,
    });
  }
  return qrMeta.get(clientId);
};

/**
 * Stops Chromium for clients that never finish scanning QR.
 * Each headless Chrome uses ~200–500 MB; leaving them running crashes small VPS/Docker hosts.
 */
const releaseQrPendingClient = async (clientId, reason) => {
  const meta = qrMeta.get(clientId);
  if (meta?.releasing) return;
  if (meta) meta.releasing = true;
  if (meta?.pendingTimer) clearTimeout(meta.pendingTimer);

  console.warn(`⏹️  ${clientId}: QR abandoned (${reason}) — stopping Chromium to free memory`);

  const wClient = activeClients.get(clientId);
  activeClients.delete(clientId);
  if (wClient) {
    try { await wClient.destroy(); } catch (_) {}
  }

  clearQrMeta(clientId);
  finishInitializing(clientId);
  blockQrReinit(clientId);
  clearClientSessionData(clientId);

  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { status: 'disconnected', qrCode: null, phone: '' }
  );
  emitToClient(clientId, 'qr_expired', {
    clientId,
    message: 'QR timed out without scan. Click Reconnect (or connect with reset=1) and scan within a few minutes.',
  });
};

const startQrPendingTimer = (clientId) => {
  const meta = getQrMeta(clientId);
  if (meta.pendingTimer) return;
  meta.pendingTimer = setTimeout(() => {
    releaseQrPendingClient(clientId, `no scan within ${getQrPendingTimeoutMs()}ms`).catch((e) =>
      console.error(`QR release failed for ${clientId}:`, e.message)
    );
  }, getQrPendingTimeoutMs());
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
  const prior = clientInitChains.get(clientId);
  if (prior) {
    try { await prior; } catch (_) {}
    if (activeClients.has(clientId)) {
      return activeClients.get(clientId);
    }
  }

  const work = createWhatsAppClientInner(clientId, opts);
  clientInitChains.set(clientId, work);
  try {
    return await work;
  } finally {
    if (clientInitChains.get(clientId) === work) {
      clientInitChains.delete(clientId);
    }
  }
};

const createWhatsAppClientInner = async (clientId, opts = {}) => {
  const { forceReauth = false, sessionMissing = false, attempt = 1, restoring = false } = opts;
  const maxRetries = getInitMaxRetries();

  cancelScheduledRetry(clientId);

  if (!forceReauth && isQrBlocked(clientId)) {
    console.log(
      `⏸️  ${clientId}: QR re-init blocked — use POST /api/clients/:id/connect?reset=1 to scan again`
    );
    return null;
  }

  if (forceReauth) {
    qrBlockedUntil.delete(clientId);
  }

  if (initializingClients.has(clientId) || activeClients.has(clientId)) {
    const existing = activeClients.get(clientId);
    if (existing) {
      console.log(`Client ${clientId} already active`);
      return existing;
    }
    console.log(`⏳ ${clientId}: init already in progress — skipping duplicate start`);
    return null;
  }

  initializingClients.add(clientId);

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
      '--disable-sync', '--mute-audio', '--disable-default-apps',
      '--disable-translate', '--disable-component-update',
      '--renderer-process-limit=1',
      '--disk-cache-size=33554432', '--media-cache-size=33554432',
      '--js-flags=--max-old-space-size=256',
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
  let readyHandled         = false;
  let authenticatedHandled = false;
  let instanceAborted  = false;

  const settleInit = () => {
    if (initSettled) return;
    initSettled = true;
    if (initTimeoutHandle) clearTimeout(initTimeoutHandle);
  };

  const scheduleRetry = async ({ timedOut = false, err = null } = {}) => {
    if (initSettled || instanceAborted) return;
    settleInit();
    clearQrMeta(clientId);
    activeClients.delete(clientId);
    finishInitializing(clientId);
    try { await wClient.destroy(); } catch (_) {}

    const canRetry = attempt <= maxRetries && (timedOut || isRetryableError(err));

    if (canRetry) {
      const lockError   = !timedOut && isProfileLockError(err);
      const delay       = lockError ? getLockRetryDelayMs() : getRetryDelayMs(attempt);
      const nextAttempt = attempt + 1;
      const reason      = timedOut ? 'timeout' : (err?.message || 'error');
      console.warn(
        `♻️  Retrying ${clientId} in ${delay}ms (${nextAttempt}/${maxRetries + 1})` +
        (lockError ? ' [profile lock]' : '')
      );
      clearChromiumLocks(clientId);
      await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'initializing', qrCode: null });
      emitToClient(clientId, 'init_retry', {
        clientId, attempt: nextAttempt, maxAttempts: maxRetries + 1,
        retryInMs: delay, reason,
      });
      cancelScheduledRetry(clientId);
      const timer = setTimeout(() => {
        scheduledRetryTimers.delete(clientId);
        clearChromiumLocks(clientId);
        createWhatsAppClient(clientId, { attempt: nextAttempt }).catch(e =>
          console.error(`Retry failed for ${clientId}:`, e)
        );
      }, delay);
      scheduledRetryTimers.set(clientId, timer);
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

    const meta = getQrMeta(clientId);
    startQrPendingTimer(clientId);

    const now = Date.now();
    if (meta.handling || (meta.refreshCount > 0 && now - meta.lastHandledAt < getQrThrottleMs())) {
      return;
    }

    if (meta.refreshCount === 0 && sessionExistsOnDisk(clientId)) {
      console.warn(
        `⚠️  ${clientId}: QR despite saved session — clearing stale session; scan new QR`
      );
      clearClientSessionData(clientId);
    }

    meta.refreshCount += 1;

    if (meta.refreshCount > getQrMaxRefreshes()) {
      console.warn(
        `⏹️  ${clientId}: QR limit reached (${meta.refreshCount}/${getQrMaxRefreshes()}) — stopping Chromium`
      );
      await releaseQrPendingClient(clientId, `${meta.refreshCount} refreshes without scan`);
      return;
    }

    meta.handling = true;
    try {
      console.log(`📱 QR for ${clientId} (#${meta.refreshCount})`);
      const qrDataUrl = await qrcode.toDataURL(qr);
      await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'qr_ready', qrCode: qrDataUrl });
      emitToClient(clientId, 'qr', { clientId, qr: qrDataUrl });
      meta.lastHandledAt = Date.now();
    } catch (e) {
      console.error(`QR error for ${clientId}:`, e);
      meta.refreshCount = Math.max(0, meta.refreshCount - 1);
    } finally {
      meta.handling = false;
    }
  });

  wClient.on('loading_screen', (percent, message) => {
    console.log(`⏳ ${clientId}: loading ${percent}% — ${message || 'syncing'}`);
  });

  wClient.on('authenticated', async () => {
    if (authenticatedHandled) return;
    authenticatedHandled = true;
    console.log(`🔑 ${clientId}: QR scanned — waiting for WhatsApp ready...`);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'authenticating', qrCode: null }
    );
    emitToClient(clientId, 'authenticated', { clientId });
  });

  wClient.on('ready', async () => {
    if (readyHandled) return;
    readyHandled = true;
    settleInit();
    clearQrMeta(clientId);
    finishInitializing(clientId);
    const phone = wClient.info?.wid?.user || '';
    console.log(`✅ Ready: ${clientId} (${phone})`);
    await disconnectDuplicatePhoneClients(clientId, phone);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'connected', qrCode: null, phone, lastConnected: new Date() }
    );
    emitToClient(clientId, 'ready', { clientId, phone });
  });

  wClient.on('auth_failure', async (msg) => {
    instanceAborted = true;
    settleInit();
    clearQrMeta(clientId);
    finishInitializing(clientId);
    console.error(`🔐 Auth failure for ${clientId}:`, msg);
    activeClients.delete(clientId);
    try { await wClient.destroy(); } catch (_) {}
    clearClientSessionData(clientId);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'auth_failure', qrCode: null, phone: '' }
    );
    emitToClient(clientId, 'auth_failure', { clientId, message: msg });
    notifyWhatsAppDisconnected({
      clientId,
      reason: String(msg || 'auth_failure'),
      eventType: 'auth_failure'
    });
  });

  wClient.on('disconnected', async (reason) => {
    instanceAborted = true;
    settleInit();
    clearQrMeta(clientId);
    finishInitializing(clientId);
    console.log(`🔌 ${clientId} disconnected: ${reason}`);

    if (shouldKeepConnectedOnDisconnect(clientId)) {
      activeClients.delete(clientId);
      console.log(`💾 ${clientId}: deploy shutdown — keeping connected status for auto-restore`);
      clientsSkippingDisconnectEmail.delete(clientId);
      return;
    }

    const skipEmail = clientsSkippingDisconnectEmail.has(clientId);
    clientsSkippingDisconnectEmail.delete(clientId);

    const logout = isLogoutDisconnect(reason);

    // Stop Chromium before deleting profile dirs (prevents ENOTEMPTY on Cache_Data).
    try {
      await wClient.destroy();
    } catch (_) {}
    activeClients.delete(clientId);
    clearChromiumLocks(clientId);

    if (logout) {
      console.warn(`🗑️  ${clientId}: clearing expired session after ${reason}`);
      await sleep(500);
      clearClientSessionData(clientId);
    }

    const statusUpdate = { status: 'disconnected', qrCode: null };
    if (logout) statusUpdate.phone = '';

    await WhatsAppClientModel.findOneAndUpdate({ clientId }, statusUpdate);
    emitToClient(clientId, 'disconnected', { clientId, reason });

    if (!skipEmail) {
      notifyWhatsAppDisconnected({
        clientId,
        reason: String(reason || 'disconnected'),
        eventType: 'disconnected'
      });
    }
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

  clearChromiumLocks(clientId);
  if (restoring) {
    await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'connected', qrCode: null });
  } else {
    await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'initializing' });
  }
  activeClients.set(clientId, wClient);
  wClient.initialize().catch(async (err) => {
    if (instanceAborted) return;
    console.error(`Failed to init ${clientId}:`, err.message);
    await scheduleRetry({ err });
  });

  return wClient;
};

// ─── Public API ───────────────────────────────────────────────────────────────

const getClient         = (clientId) => activeClients.get(clientId);
const isClientConnected = (clientId) => activeClients.has(clientId);

const destroyClient = async (clientId, options = {}) => {
  const preserveSession = options.preserveSession === true;
  if (preserveSession) {
    clientsPreservingSession.add(clientId);
  }
  if (options.skipDisconnectEmail === true) {
    clientsSkippingDisconnectEmail.add(clientId);
  }

  clearQrMeta(clientId);
  finishInitializing(clientId);
  cancelScheduledRetry(clientId);
  const wClient = activeClients.get(clientId);
  if (wClient) {
    try { await wClient.destroy(); } catch (e) {
      console.error(`Destroy error for ${clientId}:`, e);
    }
    activeClients.delete(clientId);
  }
  clearChromiumLocks(clientId);

  if (preserveSession) {
    const dbClient = await WhatsAppClientModel.findOne({ clientId });
    if (dbClient && (dbClient.status === 'connected' || dbClient.phone)) {
      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { status: 'connected', qrCode: null }
      );
      console.log(`💾 ${clientId}: session preserved on disk (DB kept connected)`);
    } else if (dbClient) {
      await WhatsAppClientModel.findOneAndUpdate({ clientId }, { qrCode: null });
    }
    // Keep clientId in clientsPreservingSession until process exits so async
    // `disconnected` events from wClient.destroy() do not mark DB disconnected.
  } else {
    clientsPreservingSession.delete(clientId);
    await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'disconnected', qrCode: null });
  }
};

/** One WhatsApp number must not stay active on multiple clients (causes QR / takeover loops). */
const disconnectDuplicatePhoneClients = async (clientId, phone) => {
  const normalized = normalizePhone(phone);
  if (!normalized) return;

  const connected = await WhatsAppClientModel.find({ status: 'connected', isActive: true });
  for (const other of connected) {
    if (other.clientId === clientId) continue;
    if (normalizePhone(other.phone) !== normalized) continue;

    console.warn(
      `⚠️  Phone ${normalized} is active on ${clientId}; disconnecting duplicate ${other.clientId}`
    );
    await destroyClient(other.clientId);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId: other.clientId },
      { status: 'disconnected', qrCode: null, phone: '' }
    );
    emitToClient(other.clientId, 'phone_conflict', {
      clientId: other.clientId,
      phone: normalized,
      activeClientId: clientId,
      message: 'This WhatsApp number is now active on another client.',
    });
  }
};

/**
 * Stops all in-memory WhatsApp clients (deploy / SIGTERM).
 * Preserves DB `connected` + session files so initWhatsAppManager can restore on boot.
 */
const destroyAllClients = async () => {
  const activeIds = [...activeClients.keys()];
  const dbConnected = await WhatsAppClientModel.find({ status: 'connected', isActive: true });
  const ids = [...new Set([
    ...activeIds,
    ...dbConnected.map((c) => c.clientId),
  ])];

  if (!ids.length) return;

  writeRestoreManifest(ids);
  console.log(
    `🧹 Stopping ${activeIds.length} active WhatsApp client(s) before shutdown (sessions preserved for restore)...`
  );
  if (activeIds.length) {
    await Promise.allSettled(activeIds.map((id) => destroyClient(id, { preserveSession: true })));
  }
};

const isRetryableSendError = (err) => {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('getchat') ||
    msg.includes('not ready') ||
    msg.includes('no active client') ||
    msg.includes('evaluation failed') ||
    msg.includes('protocol error') ||
    msg.includes('target closed') ||
    msg.includes('session closed') ||
    msg.includes('cannot read properties of undefined') ||
    msg.includes('lid is missing') ||
    msg.includes('chat table')
  );
};

/** Resolve phone → WhatsApp chat id (@c.us or @lid) via getNumberId when available. */
const resolveChatId = async (wClient, phone) => {
  const raw = String(phone || '').replace('@c.us', '').replace('@lid', '').trim();
  const digits = normalizePhone(raw).replace('@c.us', '');

  if (typeof wClient.getNumberId === 'function') {
    try {
      const numberId = await wClient.getNumberId(digits);
      if (numberId?._serialized) {
        return numberId._serialized;
      }
    } catch (e) {
      console.warn(`getNumberId failed for ${digits}:`, e.message);
    }
  }

  return digits.includes('@') ? digits : `${digits}@c.us`;
};

/** Wait until whatsapp-web.js reports CONNECTED and wid is available (avoids getChat races). */
const waitForClientReady = async (clientId, maxWaitMs = null) => {
  const deadline = Date.now() + (maxWaitMs ?? getSendReadyWaitMs());
  let lastState = 'unknown';
  let sawClient = false;

  while (Date.now() < deadline) {
    const wClient = activeClients.get(clientId);
    if (!wClient) {
      await sleep(1500);
      continue;
    }

    sawClient = true;

    if (wClient.info?.wid?.user) {
      try {
        const state = await wClient.getState();
        lastState = state || lastState;
        if (state === 'CONNECTED') {
          return wClient;
        }
      } catch (err) {
        lastState = err.message || lastState;
      }
    }

    await sleep(1500);
  }

  if (!sawClient) {
    throw new Error(`No active client for ${clientId}`);
  }

  throw new Error(
    `WhatsApp client ${clientId} not ready for sending (last state: ${lastState})`
  );
};

const sendMessage = async (clientId, phone, message, opts = null) => {
  const dbClient = await WhatsAppClientModel.findOne({ clientId });
  if (!dbClient) {
    throw new Error(`Client ${clientId} is not connected`);
  }
  if (dbClient.status !== 'connected' && !isClientConnected(clientId)) {
    throw new Error(`Client ${clientId} is not connected`);
  }

  const mediaUrl = opts?.mediaUrl && String(opts.mediaUrl).trim()
    ? String(opts.mediaUrl).trim()
    : null;

  const maxAttempts = getSendMaxRetries();
  let lastError;
  let chatId = phone.includes('@') ? phone : `${normalizePhone(phone).replace('@c.us', '')}@c.us`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const wClient = await waitForClientReady(clientId, getSendReadyWaitMs());
      chatId = await resolveChatId(wClient, phone);

      let result;
      if (mediaUrl) {
        try {
          const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
          if (!media?.data) {
            throw new Error('Media URL returned empty data');
          }
          result = await wClient.sendMessage(chatId, media, {
            caption: message || ''
          });
        } catch (err) {
          throw new Error(`Media send failed: ${err.message}`);
        }
      } else {
        result = await wClient.sendMessage(chatId, message);
      }

      await WhatsAppClientModel.findOneAndUpdate({ clientId }, { $inc: { messagesSent: 1 } });
      return result;
    } catch (err) {
      lastError = err;
      const retryable = isRetryableSendError(err) && !String(err.message || '').startsWith('Media send failed');
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      console.warn(
        `⚠️ Send attempt ${attempt}/${maxAttempts} failed for ${clientId} → ${chatId}: ${err.message}`
      );
      await sleep(2000 * attempt);
    }
  }

  throw lastError;
};

/**
 * Called on server startup. Restores only saved connected sessions.
 *
 * Clients stuck in initializing / qr_ready / auth_failure are marked disconnected
 * so Chromium is not started for un-scanned or failed clients (saves RAM on boot).
 */
const initWhatsAppManager = async () => {
  try {
    const bootDelay = getBootRestoreDelayMs();
    if (bootDelay > 0) {
      console.log(
        `⏳ Waiting ${bootDelay}ms before restoring WhatsApp (lets old container finish deploy shutdown)...`
      );
      await sleep(bootDelay);
    }

    const manifest = readRestoreManifest();
    const manifestIds = new Set(manifest?.clientIds || []);

    const [connected, inProgress, authFailed, qrReady, disconnected] = await Promise.all([
      WhatsAppClientModel.find({ status: 'connected',    isActive: true }),
      WhatsAppClientModel.find({ status: 'initializing', isActive: true }),
      WhatsAppClientModel.find({ status: 'auth_failure', isActive: true }),
      WhatsAppClientModel.find({ status: 'qr_ready',     isActive: true }),
      WhatsAppClientModel.find({ status: 'disconnected', isActive: true }),
    ]);

    const stuckClients = [...inProgress, ...qrReady, ...authFailed].filter(
      (c) => !manifestIds.has(c.clientId)
    );
    if (stuckClients.length) {
      console.log(
        `⏭️  Skipping ${stuckClients.length} stuck client(s) on boot (initializing/qr_ready/auth_failure) — reconnect manually from dashboard`
      );
      await Promise.allSettled(
        stuckClients.map((c) =>
          WhatsAppClientModel.findOneAndUpdate(
            { clientId: c.clientId },
            { status: 'disconnected', qrCode: null }
          )
        )
      );
    }

    const deployRecover = disconnected.filter(
      (c) => manifestIds.has(c.clientId) && c.phone && sessionExistsOnDisk(c.clientId)
    );
    if (deployRecover.length) {
      console.log(
        `♻️  Recovering ${deployRecover.length} client(s) marked disconnected during deploy (manifest + session on disk)`
      );
      await Promise.allSettled(
        deployRecover.map((c) =>
          WhatsAppClientModel.findOneAndUpdate(
            { clientId: c.clientId },
            { status: 'connected', qrCode: null }
          )
        )
      );
    }

    const allConnected = [
      ...connected,
      ...deployRecover.map((c) => ({ ...c, status: 'connected' })),
    ];

    const seenPhones = new Map();
    const toRestore = [];
    const duplicateConnected = [];

    for (const client of allConnected) {
      const phone = normalizePhone(client.phone);
      if (!phone) {
        toRestore.push(client);
        continue;
      }
      if (seenPhones.has(phone)) {
        duplicateConnected.push(client);
        continue;
      }
      seenPhones.set(phone, client);
      toRestore.push(client);
    }

    if (duplicateConnected.length) {
      console.log(
        `⏭️  Skipping ${duplicateConnected.length} duplicate connected client(s) — same phone already assigned`
      );
      await Promise.allSettled(
        duplicateConnected.map((c) =>
          WhatsAppClientModel.findOneAndUpdate(
            { clientId: c.clientId },
            { status: 'disconnected', qrCode: null, phone: '' }
          )
        )
      );
    }

    console.log(`🔄 Restoring ${toRestore.length} connected WhatsApp client(s) (one at a time)...`);

    const restoreOne = async (client) => {
      const { clientId } = client;

      if (!sessionExistsOnDisk(clientId)) {
        console.log(`⚠️  ${clientId}: was connected but session missing on disk → skipped (reconnect manually)`);
        console.warn(
          `⚠️  ${clientId}: mount a persistent volume at ${SESSIONS_DIR} on your host (Easypanel → Volumes)`
        );
        await WhatsAppClientModel.findOneAndUpdate(
          { clientId },
          { status: 'disconnected', qrCode: null, phone: '' }
        );
        return;
      }

      console.log(`✅ ${clientId}: session found on disk → restoring silently (status stays connected)`);
      clearChromiumLocks(clientId);
      await createWhatsAppClient(clientId, { restoring: true });
    };

    const batchSize = getRestoreBatchSize();
    for (let i = 0; i < toRestore.length; i += batchSize) {
      const batch = toRestore.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (client) => {
        try {
          await restoreOne(client);
        } catch (err) {
          console.error(`Error restoring ${client.clientId}:`, err);
        }
      }));
      if (i + batchSize < toRestore.length) {
        await new Promise((r) => setTimeout(r, getRestoreBatchDelayMs()));
      }
    }

    clearRestoreManifest();
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
  waitForClientReady,
  initWhatsAppManager,
  isClientConnected,
  isQrBlocked,
  activeClients,
};
