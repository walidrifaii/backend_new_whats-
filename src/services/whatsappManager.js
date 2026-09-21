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
const lastQrStartAt = new Map();
/** After QR abandon, Open/Share must not restart Chromium in a tight loop. */
const qrBlockedUntil = new Map();
const QR_RESTART_COOLDOWN_MS = 8000;

/** Only one Chromium launch at a time — parallel inits OOM / timeout on small VPS. */
let chromiumInitSlotsInUse = 0;
const chromiumInitWaiters = [];
const chromiumInitSlotOwners = new Set();
/** Block Open/Share QR starts until boot restore finishes. */
let bootRestoreDone = false;

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
// Backup safety net — primary stop is WA_QR_MAX_REFRESHES.
const getQrPendingTimeoutMs   = () => Math.max(60000, parseEnvInt('WA_QR_PENDING_TIMEOUT_MS', 180000));
const getQrMaxRefreshes       = () => Math.max(6, parseEnvInt('WA_QR_MAX_REFRESHES', 8));
const getQrViewGraceMs        = () => Math.max(15000, parseEnvInt('WA_QR_VIEW_GRACE_MS', 45000));
const getQrAbandonCooldownMs  = () => Math.max(60000, parseEnvInt('WA_QR_ABANDON_COOLDOWN_MS', 300000));
const getMaxConcurrentInits   = () => Math.max(1, parseEnvInt('WA_MAX_CONCURRENT_INITS', 1));
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
 * A reusable WhatsApp login exists when web.whatsapp.com IndexedDB is present.
 * Chromium always creates a `Default/` folder on first launch, even for an unscanned QR,
 * so that folder alone is NOT a saved session.
 */
const sessionExistsOnDisk = (clientId) => {
  const dirs = [
    getProfileDir(clientId),
    path.join(SESSIONS_DIR, `session-${clientId}`),
    path.join(SESSIONS_DIR, clientId),
  ];
  const seen = new Set();

  for (const profileDir of dirs) {
    if (!profileDir || seen.has(profileDir)) continue;
    seen.add(profileDir);
    if (!fs.existsSync(profileDir)) continue;
    if (fs.existsSync(path.join(profileDir, '.wwebjs_auth'))) return true;

    const idbRoot = path.join(profileDir, 'Default', 'IndexedDB');
    if (!fs.existsSync(idbRoot)) continue;
    try {
      const names = fs.readdirSync(idbRoot);
      if (names.some((n) => n.toLowerCase().includes('whatsapp'))) return true;
    } catch (_) { /* ignore unreadable profile */ }
  }
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

const acquireChromiumInitSlot = (clientId) =>
  new Promise((resolve) => {
    const tryAcquire = () => {
      if (chromiumInitSlotsInUse < getMaxConcurrentInits()) {
        chromiumInitSlotsInUse += 1;
        chromiumInitSlotOwners.add(clientId);
        resolve();
        return true;
      }
      return false;
    };
    if (!tryAcquire()) {
      console.log(
        `⏳ ${clientId}: waiting for Chromium slot (${chromiumInitSlotsInUse}/${getMaxConcurrentInits()} in use)`
      );
      chromiumInitWaiters.push(tryAcquire);
    }
  });

const releaseChromiumInitSlot = (clientId = null) => {
  if (clientId) {
    if (!chromiumInitSlotOwners.has(clientId)) return;
    chromiumInitSlotOwners.delete(clientId);
  }
  chromiumInitSlotsInUse = Math.max(0, chromiumInitSlotsInUse - 1);
  while (chromiumInitWaiters.length > 0 && chromiumInitSlotsInUse < getMaxConcurrentInits()) {
    const next = chromiumInitWaiters.shift();
    if (next && next()) break;
  }
};

const blockQrAutoRestart = (clientId) => {
  const until = Date.now() + getQrAbandonCooldownMs();
  qrBlockedUntil.set(clientId, until);
  return until;
};

const clearQrAutoRestartBlock = (clientId) => {
  qrBlockedUntil.delete(clientId);
};

const getQrAutoRestartBlockMs = (clientId) => {
  const until = qrBlockedUntil.get(clientId) || 0;
  return Math.max(0, until - Date.now());
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
      lastViewedAt: 0,
      pendingTimer: null,
      handling: false,
      releasing: false,
    });
  }
  return qrMeta.get(clientId);
};

const isQrViewerActive = (meta) =>
  Boolean(meta?.lastViewedAt && Date.now() - meta.lastViewedAt < getQrViewGraceMs());

const isClientStarting = (clientId) =>
  initializingClients.has(clientId) || clientInitChains.has(clientId) || activeClients.has(clientId);

/** Keep Chromium alive while Open/Share is being viewed. */
const markQrPageViewed = (clientId) => {
  const meta = getQrMeta(clientId);
  meta.lastViewedAt = Date.now();
  if (meta.pendingTimer) {
    clearTimeout(meta.pendingTimer);
    meta.pendingTimer = null;
  }
  startQrPendingTimer(clientId);
};

/**
 * Called from the public Open/Share QR page.
 * Restarts Chromium when a previous QR timed out so the page is not stuck on "waiting".
 * Never touch a live connected session — page auto-refresh must not kill/reinit Chromium.
 */
const requestQrForClient = async (clientId) => {
  const db = await WhatsAppClientModel.findOne({ clientId, isActive: true });
  if (!db) return { ok: false, reason: 'not_found' };

  const hasLiveSession = sessionExistsOnDisk(clientId);

  // DB says connected but session files were wiped → must show a fresh QR (not silent restore).
  if (db.status === 'connected' && !hasLiveSession && !activeClients.has(clientId)) {
    console.warn(`📱 ${clientId}: connected in DB but no session on disk — starting fresh QR`);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'initializing', qrCode: null, phone: '' }
    );
    clearQrAutoRestartBlock(clientId);
    if (!bootRestoreDone) {
      return { ok: true, boot: true, message: 'Server is finishing boot. QR will start next.' };
    }
    if (isClientStarting(clientId)) {
      markQrPageViewed(clientId);
      return { ok: true, active: true };
    }
    markQrPageViewed(clientId);
    const lastStart = lastQrStartAt.get(clientId) || 0;
    if (Date.now() - lastStart < QR_RESTART_COOLDOWN_MS) {
      return { ok: true, started: false };
    }
    lastQrStartAt.set(clientId, Date.now());
    createWhatsAppClient(clientId, { sessionMissing: true }).catch((err) => {
      console.error(`QR page init failed for ${clientId}:`, err);
    });
    return { ok: true, started: true };
  }

  // Already linked with a live browser or real session on disk.
  if (db.status === 'connected') {
    clearQrMeta(clientId);
    if (activeClients.has(clientId)) {
      return { ok: true, connected: true };
    }
    if (isClientStarting(clientId)) {
      return { ok: true, connected: true, active: true };
    }
    if (!bootRestoreDone) {
      return { ok: true, connected: true, boot: true };
    }
    const lastStart = lastQrStartAt.get(clientId) || 0;
    if (Date.now() - lastStart >= QR_RESTART_COOLDOWN_MS) {
      lastQrStartAt.set(clientId, Date.now());
      console.log(`📱 ${clientId}: Open/Share saw connected without browser — restoring session`);
      createWhatsAppClient(clientId, { restoring: true }).catch((err) => {
        console.error(`Connected restore failed for ${clientId}:`, err);
      });
    }
    return { ok: true, connected: true, restoring: true };
  }

  if (!bootRestoreDone) {
    return { ok: true, boot: true, message: 'Server is restoring other WhatsApp sessions. Try again shortly.' };
  }

  const blockedMs = getQrAutoRestartBlockMs(clientId);
  if (blockedMs > 0) {
    return {
      ok: true,
      paused: true,
      retryInMs: blockedMs,
      message: 'QR timed out. Wait before Open/Share starts Chromium again (frees memory for other numbers).',
    };
  }

  if (isClientStarting(clientId)) {
    markQrPageViewed(clientId);
    return { ok: true, active: true };
  }

  markQrPageViewed(clientId);

  const lastStart = lastQrStartAt.get(clientId) || 0;
  if (Date.now() - lastStart < QR_RESTART_COOLDOWN_MS) {
    return { ok: true, started: false };
  }
  lastQrStartAt.set(clientId, Date.now());

  console.log(`📱 ${clientId}: Open/Share requested QR — starting Chromium`);
  await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'initializing' });
  createWhatsAppClient(clientId).catch((err) => {
    console.error(`QR page init failed for ${clientId}:`, err);
  });
  return { ok: true, started: true };
};

/**
 * Stops Chromium for clients that never finish scanning QR.
 * Each headless Chrome uses ~200–500 MB; leaving them running crashes small VPS/Docker hosts.
 */
const releaseQrPendingClient = async (clientId, reason) => {
  const meta = qrMeta.get(clientId);
  if (meta?.releasing) return;

  // Never tear down a live connected WhatsApp session (Open/Share refresh used to do this).
  try {
    const db = await WhatsAppClientModel.findOne({ clientId });
    if (db?.status === 'connected' && activeClients.has(clientId)) {
      clearQrMeta(clientId);
      return;
    }
  } catch (_) {}

  if (isQrViewerActive(meta)) {
    if (meta.pendingTimer) clearTimeout(meta.pendingTimer);
    meta.pendingTimer = null;
    startQrPendingTimer(clientId);
    return;
  }
  if (meta) meta.releasing = true;
  if (meta?.pendingTimer) clearTimeout(meta.pendingTimer);

  console.warn(`⏹️  ${clientId}: QR abandoned (${reason}) — stopping Chromium to free memory`);
  const blockedUntil = blockQrAutoRestart(clientId);
  console.warn(
    `⏸️  ${clientId}: Open/Share auto-restart blocked for ${Math.round((blockedUntil - Date.now()) / 1000)}s`
  );

  const wClient = activeClients.get(clientId);
  activeClients.delete(clientId);
  if (wClient) {
    try { await wClient.destroy(); } catch (_) {}
  }

  clearQrMeta(clientId);
  finishInitializing(clientId);
  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { status: 'disconnected', qrCode: null }
  );
  emitToClient(clientId, 'qr_expired', {
    clientId,
    message: 'QR timed out without scan. Reconnect from the dashboard when ready.',
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
  // Dashboard Connect / restore may start again after an Open/Share abandon pause.
  clearQrAutoRestartBlock(clientId);

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

  if (initializingClients.has(clientId) || activeClients.has(clientId)) {
    const existing = activeClients.get(clientId);
    if (existing) {
      return existing;
    }
    return null;
  }

  initializingClients.add(clientId);

  if (attempt === 1) {
    const lastViewedAt = qrMeta.get(clientId)?.lastViewedAt || 0;
    clearQrMeta(clientId);
    if (lastViewedAt) {
      getQrMeta(clientId).lastViewedAt = lastViewedAt;
      startQrPendingTimer(clientId);
    }
  }

  const existingDb = await WhatsAppClientModel.findOne({ clientId });
  const hadSavedSession = sessionExistsOnDisk(clientId);
  const hadAuthenticatedSession = hadSavedSession && Boolean(existingDb?.phone);

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

  await acquireChromiumInitSlot(clientId);
  let slotHeld = true;
  const dropSlot = () => {
    if (!slotHeld) return;
    slotHeld = false;
    releaseChromiumInitSlot(clientId);
  };

  try {
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
  let readyHandled     = false;
  let instanceAborted  = false;

  const settleInit = () => {
    if (initSettled) return;
    initSettled = true;
    if (initTimeoutHandle) clearTimeout(initTimeoutHandle);
    dropSlot();
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
        createWhatsAppClient(clientId, {
          attempt: nextAttempt,
          restoring,
          forceReauth,
          sessionMissing,
        }).catch(e =>
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
    if (meta.releasing) return;

    if (restoring) {
      // Session files were stale/missing — if Open/Share is open, show QR; else stop Chromium.
      if (!isQrViewerActive(meta)) {
        console.warn(
          `⚠️  ${clientId}: saved session expired during restore — disconnect (scan from Open/Share)`
        );
        instanceAborted = true;
        await releaseQrPendingClient(clientId, 'expired session during restore');
        return;
      }
      console.warn(
        `⚠️  ${clientId}: session expired during restore — showing QR because Open/Share is open`
      );
    }

    startQrPendingTimer(clientId);

    const now = Date.now();
    const viewerActive = isQrViewerActive(meta);
    if (meta.handling || (meta.lastHandledAt && now - meta.lastHandledAt < getQrThrottleMs())) {
      return;
    }

    // Count only QRs that were actually shown. Rapid WhatsApp events must not kill Chromium
    // before Open/Share can display the first code.
    if (!viewerActive && meta.refreshCount >= getQrMaxRefreshes()) {
      console.warn(
        `⏹️  ${clientId}: QR limit reached (${meta.refreshCount}/${getQrMaxRefreshes()}) — stopping Chromium`
      );
      await releaseQrPendingClient(clientId, `${meta.refreshCount} refreshes without scan`);
      return;
    }

    meta.handling = true;
    try {
      const nextCount = meta.refreshCount + 1;
      if (nextCount === 1 && hadAuthenticatedSession && !forceReauth && !sessionMissing) {
        console.warn(
          `⚠️  ${clientId}: previous WhatsApp login expired — scan the QR on Open/Share to reconnect`
        );
      }
      console.log(`📱 QR for ${clientId} (#${nextCount})`);
      const qrDataUrl = await qrcode.toDataURL(qr);
      if (meta.releasing || activeClients.get(clientId) !== wClient) return;

      await WhatsAppClientModel.findOneAndUpdate({ clientId }, { status: 'qr_ready', qrCode: qrDataUrl });
      emitToClient(clientId, 'qr', { clientId, qr: qrDataUrl });
      meta.refreshCount = nextCount;
      meta.lastHandledAt = Date.now();
    } catch (e) {
      console.error(`QR error for ${clientId}:`, e);
    } finally {
      meta.handling = false;
    }
  });

  wClient.on('ready', async () => {
    if (readyHandled) return;
    readyHandled = true;
    settleInit();
    clearQrMeta(clientId);
    lastQrStartAt.delete(clientId);
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
    activeClients.delete(clientId);

    if (shouldKeepConnectedOnDisconnect(clientId)) {
      console.log(`💾 ${clientId}: deploy shutdown — keeping connected status for auto-restore`);
      clientsSkippingDisconnectEmail.delete(clientId);
      return;
    }

    const skipEmail = clientsSkippingDisconnectEmail.has(clientId);
    clientsSkippingDisconnectEmail.delete(clientId);

    const logout = isLogoutDisconnect(reason);
    if (logout) {
      console.warn(`🗑️  ${clientId}: clearing expired session after ${reason}`);
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
      const assignedIds = await WhatsAppClientModel.listAssignedUserIds(dbClient._id);
      const logUserId = assignedIds[0];
      if (!logUserId) return;
      await MessageLog.create({
        userId: logUserId, clientId: dbClient._id,
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
  } catch (err) {
    dropSlot();
    finishInitializing(clientId);
    activeClients.delete(clientId);
    throw err;
  }
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
  releaseChromiumInitSlot(clientId);
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
    msg.includes('cannot read properties of undefined')
  );
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
  if (!dbClient || dbClient.status !== 'connected') {
    throw new Error(`Client ${clientId} is not connected`);
  }

  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  const mediaUrl = opts?.mediaUrl && String(opts.mediaUrl).trim()
    ? String(opts.mediaUrl).trim()
    : null;

  const maxAttempts = getSendMaxRetries();
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const wClient = await waitForClientReady(clientId, getSendReadyWaitMs());

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
  bootRestoreDone = false;
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

    // After a QR/connect race, status can stay initializing/qr_ready even though the
    // number was scanned. Recover those instead of skipping → forcing another QR.
    const stuckRecoverable = [];
    const stuckDrop = [];
    for (const c of stuckClients) {
      const hasPhone = Boolean(normalizePhone(c.phone));
      const hasSession = sessionExistsOnDisk(c.clientId);
      if (c.status !== 'auth_failure' && hasPhone && hasSession) {
        stuckRecoverable.push(c);
      } else {
        stuckDrop.push(c);
      }
    }

    if (stuckRecoverable.length) {
      console.log(
        `♻️  Recovering ${stuckRecoverable.length} stuck client(s) with phone + session on disk (status was initializing/qr_ready)`
      );
      await Promise.allSettled(
        stuckRecoverable.map((c) =>
          WhatsAppClientModel.findOneAndUpdate(
            { clientId: c.clientId },
            { status: 'connected', qrCode: null }
          )
        )
      );
    }

    if (stuckDrop.length) {
      console.log(
        `⏭️  Skipping ${stuckDrop.length} stuck client(s) on boot (no reusable session) — reconnect manually from dashboard`
      );
      await Promise.allSettled(
        stuckDrop.map((c) =>
          WhatsAppClientModel.findOneAndUpdate(
            { clientId: c.clientId },
            {
              status: 'disconnected',
              qrCode: null,
              ...(c.status === 'auth_failure' ? { phone: '' } : {}),
            }
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
      ...stuckRecoverable.map((c) => ({ ...c, status: 'connected' })),
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
  } finally {
    bootRestoreDone = true;
  }
};

/**
 * Stops every Chromium client, deletes all session folders, resets DB to disconnected.
 * After this, every number needs a fresh QR scan.
 */
const clearAllWhatsAppSessions = async () => {
  const activeIds = [...activeClients.keys()];
  console.warn(`🗑️  Clearing ALL WhatsApp sessions (${activeIds.length} active browser(s))...`);

  await Promise.allSettled(
    activeIds.map((id) => destroyClient(id, { skipDisconnectEmail: true }))
  );

  for (const timer of scheduledRetryTimers.values()) clearTimeout(timer);
  scheduledRetryTimers.clear();
  initializingClients.clear();
  clientInitChains.clear();
  qrMeta.clear();
  lastQrStartAt.clear();
  qrBlockedUntil.clear();
  chromiumInitWaiters.length = 0;
  chromiumInitSlotsInUse = 0;
  chromiumInitSlotOwners.clear();
  clientsPreservingSession.clear();
  clearRestoreManifest();

  let removedDirs = 0;
  if (fs.existsSync(SESSIONS_DIR)) {
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
      if (name === '.' || name === '..') continue;
      const full = path.join(SESSIONS_DIR, name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removedDirs += 1;
        console.log(`🗑️  Removed ${full}`);
      } catch (e) {
        console.error(`Failed to remove ${full}:`, e.message);
      }
    }
  }

  const clients = await WhatsAppClientModel.find({ isActive: true });
  await Promise.allSettled(
    clients.map((c) =>
      WhatsAppClientModel.findOneAndUpdate(
        { clientId: c.clientId },
        { status: 'disconnected', qrCode: null, phone: '' }
      )
    )
  );

  console.warn(
    `✅ Cleared ${removedDirs} session path(s); ${clients.length} number(s) set to disconnected`
  );
  return {
    stoppedBrowsers: activeIds.length,
    removedPaths: removedDirs,
    resetClients: clients.length,
  };
};

module.exports = {
  createWhatsAppClient,
  getClient,
  destroyClient,
  destroyAllClients,
  clearAllWhatsAppSessions,
  sendMessage,
  waitForClientReady,
  initWhatsAppManager,
  isClientConnected,
  requestQrForClient,
  activeClients,
};
