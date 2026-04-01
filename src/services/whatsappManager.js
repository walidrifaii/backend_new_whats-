const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const MessageLog = require('../models/MessageLog');
const { emitToClient } = require('../utils/socket');

// In-memory map of active WhatsApp client instances
const activeClients = new Map();

const parseEnvInt = (key, fallback) => {
  const value = parseInt(process.env[key] || `${fallback}`, 10);
  return Number.isFinite(value) ? value : fallback;
};

const getInitTimeoutMs = () => parseEnvInt('WA_INIT_TIMEOUT_MS', 180000);
const getInitMaxRetries = () => Math.max(0, parseEnvInt('WA_INIT_MAX_RETRIES', 2));
const getInitRetryBaseDelayMs = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_BASE_DELAY_MS', 5000));
const getInitRetryMaxDelayMs = () => Math.max(1000, parseEnvInt('WA_INIT_RETRY_MAX_DELAY_MS', 30000));

const getDefaultSessionsDir = () => {
  if (process.env.NODE_ENV === 'production') {
    return path.join(os.tmpdir(), 'wwebjs-sessions');
  }
  return path.resolve(__dirname, '../../sessions');
};

const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : getDefaultSessionsDir();

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
  removePathIfExists(path.join(SESSIONS_DIR, `session-${clientId}`));
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

const buildInitErrorMessage = ({ clientId, err, timedOut, attempt, maxRetries }) => {
  const attemptsTotal = maxRetries + 1;
  const base =
    timedOut
      ? `WhatsApp initialization timed out for ${clientId}.`
      : `WhatsApp initialization failed for ${clientId}.`;

  const details = err?.message ? ` Reason: ${err.message}` : '';
  const attemptText = ` Attempt ${attempt}/${attemptsTotal}.`;
  const hint =
    ' If running on Render free tier, warm-up/cold starts can delay QR. Check Chrome path and increase WA_INIT_TIMEOUT_MS.';

  return `${base}${attemptText}${details}${hint}`;
};

/**
 * Downloads an image from a URL and returns a whatsapp-web.js MessageMedia object.
 * Falls back gracefully on failure.
 */
const fetchMediaFromUrl = (url) => {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchMediaFromUrl(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching media: ${url}`));
      }

      const contentType = res.headers['content-type'] || 'image/jpeg';
      const mimeType = contentType.split(';')[0].trim();

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');

        // Derive a filename from the URL
        const urlPath = new URL(url).pathname;
        const filename = path.basename(urlPath) || 'media';

        resolve(new MessageMedia(mimeType, base64, filename));
      });
      res.on('error', reject);
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timeout fetching media from: ${url}`));
    });
  });
};

/**
 * Creates and initializes a WhatsApp client for a given clientId
 */
const createWhatsAppClient = async (clientId, options = {}) => {
  const { forceReauth = false, attempt = 1 } = options;
  const maxRetries = getInitMaxRetries();

  if (activeClients.has(clientId)) {
    console.log(`Client ${clientId} already active`);
    return activeClients.get(clientId);
  }

  console.log(`Initializing WhatsApp client: ${clientId}`);

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
  let initSettled = false;
  const settleInit = () => {
    initSettled = true;
    if (initTimeoutHandle) clearTimeout(initTimeoutHandle);
  };

  const scheduleRetry = async ({ timedOut = false, err = null }) => {
    if (initSettled) return;
    settleInit();
    activeClients.delete(clientId);

    try {
      await wClient.destroy();
    } catch (_) {}

    const canRetry = attempt <= maxRetries && (timedOut || isRetryableInitError(err));

    if (canRetry) {
      const retryDelayMs = getRetryDelayMs(attempt);
      const retryAttempt = attempt + 1;
      console.warn(
        `Retrying WhatsApp init for ${clientId} in ${retryDelayMs}ms ` +
        `(attempt ${retryAttempt}/${maxRetries + 1})`
      );

      await WhatsAppClientModel.findOneAndUpdate(
        { clientId },
        { status: 'initializing', qrCode: null }
      );

      emitToClient(clientId, 'init_retry', {
        clientId,
        attempt: retryAttempt,
        maxAttempts: maxRetries + 1,
        retryInMs: retryDelayMs,
        reason: timedOut ? 'timeout' : (err?.message || 'retryable-init-error')
      });

      setTimeout(() => {
        createWhatsAppClient(clientId, { forceReauth: false, attempt: retryAttempt }).catch((retryErr) => {
          console.error(`Retry bootstrap failed for ${clientId}:`, retryErr);
        });
      }, retryDelayMs);

      return;
    }

    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null }
    );

    emitToClient(clientId, 'init_error', {
      clientId,
      message: buildInitErrorMessage({ clientId, err, timedOut, attempt, maxRetries })
    });
  };

  const initTimeoutHandle = setTimeout(async () => {
    if (initSettled) return;
    console.error(`Initialization timeout for ${clientId} after ${initTimeoutMs}ms`);
    await scheduleRetry({ timedOut: true });
  }, initTimeoutMs);

  wClient.on('qr', async (qr) => {
    console.log(`QR received for client: ${clientId}`);
    settleInit();
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

  wClient.on('ready', async () => {
    console.log(`✅ WhatsApp client ready: ${clientId}`);
    settleInit();
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

  wClient.on('auth_failure', async (msg) => {
    console.error(`Auth failure for ${clientId}:`, msg);
    settleInit();
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'auth_failure', qrCode: null }
    );
    emitToClient(clientId, 'auth_failure', { clientId, message: msg });
    activeClients.delete(clientId);
  });

  wClient.on('disconnected', async (reason) => {
    console.log(`Client ${clientId} disconnected:`, reason);
    settleInit();
    await WhatsAppClientModel.findOneAndUpdate(
      { clientId },
      { status: 'disconnected', qrCode: null }
    );
    emitToClient(clientId, 'disconnected', { clientId, reason });
    activeClients.delete(clientId);
  });

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

  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { status: 'initializing' }
  );

  activeClients.set(clientId, wClient);
  wClient.initialize().catch(async (err) => {
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
 * Send a text-only message
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

  await WhatsAppClientModel.findOneAndUpdate(
    { clientId },
    { $inc: { messagesSent: 1 } }
  );

  return result;
};

/**
 * Send an image message with optional caption.
 * Falls back to sending caption as plain text if media fetch fails.
 *
 * @param {string} clientId  - internal client ID string
 * @param {string} phone     - recipient phone number
 * @param {string} imageUrl  - publicly reachable URL of the image
 * @param {string} caption   - text shown below the image (supports template variables, already rendered)
 */
const sendImageMessage = async (clientId, phone, imageUrl, caption = '') => {
  const wClient = activeClients.get(clientId);
  if (!wClient) throw new Error(`No active client for ${clientId}`);

  const dbClient = await WhatsAppClientModel.findOne({ clientId });
  if (!dbClient || dbClient.status !== 'connected') {
    throw new Error(`Client ${clientId} is not connected`);
  }

  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;

  let result;
  try {
    const media = await fetchMediaFromUrl(imageUrl);
    result = await wClient.sendMessage(chatId, media, {
      caption: caption || undefined
    });
    console.log(`🖼️  Image sent to ${phone} (caption: ${caption ? 'yes' : 'no'})`);
  } catch (mediaErr) {
    // If media fetch/send fails, fall back to text-only so the contact isn't lost
    console.error(`⚠️  Image send failed for ${phone}, falling back to text:`, mediaErr.message);
    const fallbackText = caption || imageUrl;
    result = await wClient.sendMessage(chatId, fallbackText);
  }

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
      status: 'connected',
      isActive: true
    });

    console.log(`🔄 Restoring ${connectedClients.length} WhatsApp sessions...`);

    for (const client of connectedClients) {
      try {
        await createWhatsAppClient(client.clientId);
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
  sendImageMessage,
  initWhatsAppManager,
  isClientConnected,
  activeClients
};
