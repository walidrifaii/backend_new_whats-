const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const { emitToClient } = require('../utils/socket');

// In-memory map of active WhatsApp client instances
const activeClients = new Map();
const pendingClientStarts = new Map();
const stoppedClientStarts = new Map();
const retryTimeoutHandles = new Map();
const qrEventCounts = new Map();
const preservingClientShutdowns = new Set();
const profileLockRetryCounts = new Map();
let isManagerShuttingDown = false;

const parseEnvInt = (key, fallback) => {
  const value = parseInt(process.env[key] || `${fallback}`, 10);
  return Number.isFinite(value) ? value : fallback;
};

const getInitTimeoutMs = () => parseEnvInt('WA_INIT_TIMEOUT_MS', 180000);
const getReadyTimeoutMs = () => parseEnvInt('WA_READY_TIMEOUT_MS', getInitTimeoutMs());
const getInitMaxAttempts = () => Math.max(1, parseEnvInt('WA_INIT_MAX_ATTEMPTS', 4));
const getMaxQrEvents = () => Math.max(1, parseEnvInt('WA_MAX_QR_EVENTS', 4));
const getInitRetryBaseDelayMs = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_BASE_DELAY_MS', 5000));
const getInitRetryMaxDelayMs = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_MAX_DELAY_MS', 30000));
const getProfileLockRetryDelayMs = () => Math.max(5000, parseEnvInt('WA_PROFILE_LOCK_RETRY_DELAY_MS', 15000));
const getProfileLockMaxRetries = () => Math.max(1, parseEnvInt('WA_PROFILE_LOCK_MAX_RETRIES', 12));
const getRestoreStartDelayMs = () => Math.max(0, parseEnvInt('WA_RESTORE_START_DELAY_MS', 30000));

const getDefaultSessionsDir = () => {
  // On cloud hosts, app directory may be ephemeral/restricted.
  if (process.env.NODE_ENV === 'production') {
    return path.join(os.tmpdir(), 'wwebjs-sessions');
  }
  return path.resolve(__dirname, '../../sessions');
};

const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : getDefaultSessionsDir();

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const resolveBundledChromePath = () => {
  const chromeRoot = path.resolve(__dirname, '../../.puppeteer/chrome');
  if (!fs.existsSync(chromeRoot)) return null;

  const linuxBuilds = fs.readdirSync(chromeRoot)
    .filter(name => name.startsWith('linux-'))
    .sort();

  if (!linuxBuilds.length) return null;

  // Pick the newest downloaded build directory.
  const latestLinuxBuild = linuxBuilds[linuxBuilds.length - 1];
  const executablePath = path.join(
    chromeRoot,
    latestLinuxBuild,
    'chrome-linux64',
    'chrome'
  );

  return fs.existsSync(executablePath) ? executablePath : null;
};

const removePathIfExists = (targetPath) => {
  try {
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed removing path ${targetPath}:`, err.message);
  }
};

const clearClientSessionData = (clientId) => {
  // whatsapp-web.js LocalAuth usually stores session as "session-<clientId>".
  removePathIfExists(path.join(SESSIONS_DIR, `session-${clientId}`));
  // Keep compatibility with older/custom layouts.
  removePathIfExists(path.join(SESSIONS_DIR, clientId));
};

const getRetryDelayMs = (attempt) => {
  const baseDelay = getInitRetryBaseDelayMs();
  const maxDelay = getInitRetryMaxDelayMs();
  const delay = baseDelay * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, maxDelay);
};

const isRetryableInitError = (err) => {
  const msg = (err?.message || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('target closed') ||
    msg.includes('navigation') ||
    msg.includes('browser') ||
    msg.includes('websocket')
  );
};

const isProfileLockedError = (err) => {
  const msg = `${err?.message || ''}\n${err?.stack || ''}`.toLowerCase();
  return (
    msg.includes('profile appears to be in use') ||
    msg.includes('chromium has locked the profile') ||
    msg.includes('process_singleton') ||
    msg.includes('singletonlock') ||
    msg.includes('code: 21')
  );
};

const buildInitErrorMessage = ({ clientId, err, timedOut, attempt, maxAttempts }) => {
  const base =
    timedOut
      ? `WhatsApp initialization timed out for ${clientId}.`
      : `WhatsApp initialization failed for ${clientId}.`;

  const details = err?.message ? ` Reason: ${err.message}` : '';
  const attemptText = ` Attempt ${attempt}/${maxAttempts}.`;
  const hint =
    ' Stopped creating new QR sessions after the maximum attempts. Use reset=1 or forceReauth to try again.';

  return `${base}${attemptText}${details}${hint}`;
};

const getClientStartProgress = (clientId) => pendingClientStarts.get(clientId) || null;
const getClientStartBlock = (clientId) => stoppedClientStarts.get(clientId) || null;
const clearClientStartBlock = (clientId) => stoppedClientStarts.delete(clientId);
const clearQrEventCount = (clientId) => qrEventCounts.delete(clientId);
const clearProfileLockRetryCount = (clientId) => profileLockRetryCounts.delete(clientId);

const clearRetryTimeout = (clientId) => {
  const retryTimeoutHandle = retryTimeoutHandles.get(clientId);
  if (retryTimeoutHandle) {
    clearTimeout(retryTimeoutHandle);
    retryTimeoutHandles.delete(clientId);
  }
};

const clearClientStartProgress = (clientId) => {
  pendingClientStarts.delete(clientId);
  clearRetryTimeout(clientId);
};

const clearAllRetryTimeouts = () => {
  retryTimeoutHandles.forEach((retryTimeoutHandle) => clearTimeout(retryTimeoutHandle));
  retryTimeoutHandles.clear();
};

const incrementQrEventCount = (clientId) => {
  const count = (qrEventCounts.get(clientId) || 0) + 1;
  qrEventCounts.set(clientId, count);
  return count;
};

/**
 * Creates and initializes a WhatsApp client for a given clientId
 */
const createWhatsAppClient = async (clientId, options = {}) => {
  const { forceReauth = false, attempt = 1, preserveStatusOnInit = false } = options;
  const maxAttempts = getInitMaxAttempts();

  if (isManagerShuttingDown) {
    throw new Error(`WhatsApp manager is shutting down; skipped init for ${clientId}`);
  }

  if (forceReauth && attempt === 1) {
    clearClientStartBlock(clientId);
    clearClientStartProgress(clientId);
    clearQrEventCount(clientId);
    clearProfileLockRetryCount(clientId);
  }

  const startBlock = getClientStartBlock(clientId);
  if (startBlock && !forceReauth) {
    const message =
      `WhatsApp client ${clientId} stopped: ${startBlock.reason || 'maximum attempts reached'}. ` +
      'Use reset=1 or forceReauth to try again.';
    console.warn(message);
    emitToClient(clientId, 'init_error', { clientId, message });
    throw new Error(message);
  }

  const startProgress = getClientStartProgress(clientId);
  if (attempt === 1 && startProgress && !forceReauth) {
    const message =
      `WhatsApp client ${clientId} is already ${startProgress.status} ` +
      `(attempt ${startProgress.attempt}/${startProgress.maxAttempts}). Wait for it to finish.`;
    console.log(message);
    return activeClients.get(clientId) || null;
  }

  if (activeClients.has(clientId)) {
    console.log(`Client ${clientId} already active`);
    return activeClients.get(clientId);
  }

  pendingClientStarts.set(clientId, {
    attempt,
    maxAttempts,
    status: 'initializing',
    startedAt: new Date()
  });
  console.log(`Initializing WhatsApp client: ${clientId} (attempt ${attempt}/${maxAttempts})`);

  if (forceReauth && attempt === 1) {
    console.log(`Clearing stale session data for ${clientId}`);
    clearClientSessionData(clientId);
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null, phone: '' }
    );
  }

  const chromeExecutablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_BIN ||
    resolveBundledChromePath();

  const puppeteerConfig = {
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
  };

  if (chromeExecutablePath) {
    puppeteerConfig.executablePath = chromeExecutablePath;
    console.log(`Using Chrome executable at: ${chromeExecutablePath}`);
  }

  const wClient = new Client({
    authStrategy: new LocalAuth({
      clientId: clientId,
      dataPath: SESSIONS_DIR
    }),
    puppeteer: puppeteerConfig,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0
  });

  const initTimeoutMs = getInitTimeoutMs();
  const readyTimeoutMs = getReadyTimeoutMs();
  const maxQrEvents = getMaxQrEvents();
  let attemptFinished = false;
  let ready = false;
  let connectTimeoutHandle = null;

  const clearInitTimer = () => {
    if (initTimeoutHandle) clearTimeout(initTimeoutHandle);
  };

  const clearConnectTimer = () => {
    if (connectTimeoutHandle) {
      clearTimeout(connectTimeoutHandle);
      connectTimeoutHandle = null;
    }
  };

  const finishAttempt = () => {
    attemptFinished = true;
    clearInitTimer();
    clearConnectTimer();
  };

  const scheduleRetry = async ({ timedOut = false, err = null, retryable = null }) => {
    if (attemptFinished) return;
    finishAttempt();
    activeClients.delete(clientId);

    if (isManagerShuttingDown || preservingClientShutdowns.has(clientId)) {
      console.log(`Skipped retry for ${clientId} because WhatsApp manager is shutting down`);
      return;
    }

    try {
      await wClient.destroy();
    } catch (_) {}

    const profileLocked = isProfileLockedError(err);
    if (profileLocked) {
      const lockRetryCount = (profileLockRetryCounts.get(clientId) || 0) + 1;
      const maxLockRetries = getProfileLockMaxRetries();

      if (lockRetryCount <= maxLockRetries) {
        const retryDelayMs = getProfileLockRetryDelayMs();
        profileLockRetryCounts.set(clientId, lockRetryCount);
        pendingClientStarts.set(clientId, {
          attempt,
          maxAttempts,
          retryInMs: retryDelayMs,
          status: 'waiting-for-profile-lock',
          startedAt: new Date()
        });
        console.warn(
          `Chrome profile is still locked for ${clientId}. ` +
          `Waiting ${retryDelayMs}ms before retry ${lockRetryCount}/${maxLockRetries}.`
        );

        const retryTimeoutHandle = setTimeout(() => {
          retryTimeoutHandles.delete(clientId);
          createWhatsAppClient(clientId, {
            forceReauth: false,
            attempt,
            preserveStatusOnInit
          }).catch((retryErr) => {
            console.error(`Profile-lock retry failed for ${clientId}:`, retryErr);
          });
        }, retryDelayMs);
        retryTimeoutHandles.set(clientId, retryTimeoutHandle);
        return;
      }

      clearClientStartProgress(clientId);
      console.error(
        `Chrome profile stayed locked for ${clientId} after ${maxLockRetries} retries. ` +
        'Preserving WhatsApp session data and database status.'
      );
      emitToClient(clientId, 'init_error', {
        clientId,
        message:
          `Chrome profile is still locked for ${clientId}. ` +
          'The old deployment may still be stopping. Try again after it fully exits.'
      });
      return;
    }

    clearProfileLockRetryCount(clientId);
    clearClientSessionData(clientId);

    const shouldRetry = retryable === null
      ? (timedOut || isRetryableInitError(err))
      : retryable;
    const canRetry = attempt < maxAttempts && shouldRetry;

    if (canRetry) {
      const retryDelayMs = getRetryDelayMs(attempt);
      const retryAttempt = attempt + 1;
      pendingClientStarts.set(clientId, {
        attempt: retryAttempt,
        maxAttempts,
        retryInMs: retryDelayMs,
        status: 'retrying',
        startedAt: new Date()
      });
      console.warn(
        `WhatsApp init failed for ${clientId} (attempt ${attempt}/${maxAttempts}). ` +
        `Retrying in ${retryDelayMs}ms (attempt ${retryAttempt}/${maxAttempts})`
      );

      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        preserveStatusOnInit ? { qrCode: null } : { status: 'initializing', qrCode: null }
      );

      emitToClient(clientId, 'init_retry', {
        clientId,
        attempt: retryAttempt,
        maxAttempts,
        retryInMs: retryDelayMs,
        reason: timedOut ? 'timeout' : (err?.message || 'retryable-init-error')
      });

      const retryTimeoutHandle = setTimeout(() => {
        retryTimeoutHandles.delete(clientId);
        createWhatsAppClient(clientId, {
          forceReauth: false,
          attempt: retryAttempt,
          preserveStatusOnInit
        }).catch((retryErr) => {
          console.error(`Retry bootstrap failed for ${clientId}:`, retryErr);
        });
      }, retryDelayMs);
      retryTimeoutHandles.set(clientId, retryTimeoutHandle);

      return;
    }

    clearClientStartProgress(clientId);
    clearQrEventCount(clientId);
    clearProfileLockRetryCount(clientId);
    stoppedClientStarts.set(clientId, {
      maxAttempts,
      failedAt: new Date(),
      reason: timedOut ? 'timeout' : (err?.message || 'init-failed')
    });

    console.error(
      `WhatsApp init stopped for ${clientId} after ${attempt}/${maxAttempts} attempts. ` +
      'No more QR sessions will be created until reset=1 or forceReauth is used.'
    );

    if (!preserveStatusOnInit) {
      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { status: 'disconnected', qrCode: null }
      );
    } else {
      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { qrCode: null }
      );
    }

    emitToClient(clientId, 'init_error', {
      clientId,
      message: buildInitErrorMessage({ clientId, err, timedOut, attempt, maxAttempts })
    });
  };

  // Prevent "initializing forever" when deployment cannot reach QR/ready.
  const initTimeoutHandle = setTimeout(async () => {
    if (attemptFinished) return;
    console.error(
      `Initialization timeout for ${clientId} after ${initTimeoutMs}ms ` +
      `(attempt ${attempt}/${maxAttempts})`
    );
    await scheduleRetry({ timedOut: true });
  }, initTimeoutMs);

  // QR Code event
  wClient.on('qr', async (qr) => {
    if (attemptFinished) return;
    const qrEventCount = incrementQrEventCount(clientId);

    if (qrEventCount > maxQrEvents) {
      const err = new Error(`QR limit reached (${maxQrEvents}) without connection`);
      console.error(`${err.message} for ${clientId}. Stopping QR generation.`);
      await scheduleRetry({ err, retryable: false });
      return;
    }

    clearInitTimer();
    console.log(
      `QR received for client: ${clientId} ` +
      `(QR ${qrEventCount}/${maxQrEvents}, attempt ${attempt}/${maxAttempts})`
    );

    if (!connectTimeoutHandle) {
      console.log(
        `Waiting for WhatsApp connection for ${clientId} up to ${readyTimeoutMs}ms ` +
        `(attempt ${attempt}/${maxAttempts})`
      );
      connectTimeoutHandle = setTimeout(async () => {
        if (attemptFinished || ready) return;
        const err = new Error(`QR was not connected within ${readyTimeoutMs}ms`);
        console.error(`${err.message} for ${clientId} (attempt ${attempt}/${maxAttempts})`);
        await scheduleRetry({ timedOut: true, err, retryable: true });
      }, readyTimeoutMs);
    }

    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      if (attemptFinished || ready) return;
      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { status: 'qr_ready', qrCode: qrDataUrl }
      );
      emitToClient(clientId, 'qr', { clientId, qr: qrDataUrl });

      if (qrEventCount >= maxQrEvents && !ready) {
        const err = new Error(`QR limit reached (${maxQrEvents}) without connection`);
        console.error(`${err.message} for ${clientId}. No more QR sessions will be created.`);
        await scheduleRetry({ err, retryable: false });
      }
    } catch (err) {
      console.error(`QR generation error for ${clientId}:`, err);
    }
  });

  // Ready event
  wClient.on('ready', async () => {
    ready = true;
    console.log(`✅ WhatsApp client ready: ${clientId}`);
    finishAttempt();
    clearClientStartProgress(clientId);
    clearClientStartBlock(clientId);
    clearQrEventCount(clientId);
    clearProfileLockRetryCount(clientId);
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
    console.error(`Auth failure for ${clientId} (attempt ${attempt}/${maxAttempts}):`, msg);
    emitToClient(clientId, 'auth_failure', { clientId, message: msg });
    await scheduleRetry({
      err: new Error(String(msg || 'auth_failure')),
      retryable: true
    });
  });

  // Disconnected event
  wClient.on('disconnected', async (reason) => {
    console.log(`Client ${clientId} disconnected:`, reason);
    if (preservingClientShutdowns.has(clientId)) {
      finishAttempt();
      clearClientStartProgress(clientId);
      activeClients.delete(clientId);
      console.log(`Preserved database status for ${clientId} during server shutdown`);
      return;
    }

    if (!ready) {
      await scheduleRetry({
        err: new Error(`Disconnected before ready: ${reason || 'unknown reason'}`),
        retryable: true
      });
      return;
    }

    finishAttempt();
    clearClientStartProgress(clientId);
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

      const bodyText = typeof msg.body === 'string' ? msg.body.trim() : '';
      const captionText = typeof msg?._data?.caption === 'string' ? msg._data.caption.trim() : '';
      const messageType = msg?.type || (msg?.hasMedia ? 'media' : 'unknown');
      const messageTextForLog = bodyText || captionText || `[${messageType}]`;
      const normalizedPhone = (msg.from || '').replace('@c.us', '');

      console.log(`📨 Incoming message for ${clientId} from ${msg.from}: ${messageTextForLog}`);

      await MessageLog.create({
        userId: dbClient.userId,
        clientId: dbClient._id,
        phone: normalizedPhone,
        message: messageTextForLog,
        direction: 'incoming',
        status: 'received',
        whatsappMessageId: msg?.id?._serialized
      });

      emitToClient(clientId, 'incoming-message', {
        clientId,
        from: msg.from,
        body: bodyText || captionText || '',
        type: messageType,
        timestamp: msg.timestamp
      });
    } catch (err) {
      console.error('Error saving incoming message:', err);
    }
  });

  // Initialize the client
  if (!preserveStatusOnInit) {
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'initializing' }
    );
  }

  activeClients.set(clientId, wClient);
  wClient.initialize().catch(async (err) => {
    activeClients.delete(clientId);
    console.error(`Failed to initialize WhatsApp client ${clientId}:`, err);
    await scheduleRetry({ err });
  });

  return wClient;
};

/**
 * Get an active client instance
 */
const getClient = (clientId) => activeClients.get(clientId);

/**
 * Destroy and remove a client
 */
const destroyClient = async (clientId, options = {}) => {
  const { preserveStatus = false } = options;
  const wClient = activeClients.get(clientId);

  if (preserveStatus) {
    preservingClientShutdowns.add(clientId);
  }

  if (wClient) {
    try {
      await wClient.destroy();
    } catch (err) {
      console.error(`Error destroying client ${clientId}:`, err);
    }
    activeClients.delete(clientId);
  }

  if (preserveStatus) {
    setTimeout(() => preservingClientShutdowns.delete(clientId), 10000);
    return;
  }

  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { status: 'disconnected', qrCode: null }
  );
};

const shutdownWhatsAppManager = async () => {
  isManagerShuttingDown = true;
  clearAllRetryTimeouts();

  const clientIds = Array.from(activeClients.keys());
  console.log(`🧹 Closing ${clientIds.length} WhatsApp client(s) without changing DB status...`);

  await Promise.all(clientIds.map(async (clientId) => {
    try {
      await destroyClient(clientId, { preserveStatus: true });
    } catch (err) {
      console.error(`Error closing client ${clientId} during shutdown:`, err);
    }
  }));
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
    const restoreStartDelayMs = getRestoreStartDelayMs();
    if (restoreStartDelayMs > 0) {
      console.log(`⏳ Waiting ${restoreStartDelayMs}ms before restoring WhatsApp sessions...`);
      await new Promise(r => setTimeout(r, restoreStartDelayMs));
    }

    if (isManagerShuttingDown) return;

    const connectedClients = await WhatsAppClientModel.find({
      status: 'connected',
      isActive: true
    });

    console.log(`🔄 Restoring ${connectedClients.length} WhatsApp sessions...`);

    for (const client of connectedClients) {
      try {
        await createWhatsAppClient(client.clientId, { preserveStatusOnInit: true });
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
  getClientStartProgress,
  getClientStartBlock,
  destroyClient,
  shutdownWhatsAppManager,
  sendMessage,
  initWhatsAppManager,
  isClientConnected,
  activeClients
};
