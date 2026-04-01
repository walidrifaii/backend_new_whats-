/**
 * Renders a templated message by replacing {variable} placeholders
 * with values from the contact's data.
 *
 * @param {string} template - The message template, e.g. "Hello {name}, your code is {code}"
 * @param {object} variables - Key-value pairs for substitution
 * @returns {string} - The rendered message
 */
const renderTemplate = (template, variables = {}) => {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
};

/**
 * Normalizes a phone number to WhatsApp format (country code + number + @c.us)
 */
const normalizePhone = (phone) => {
  const raw = String(phone).trim();
  if (/@(c|g)\.us$/i.test(raw)) {
    return raw.replace(/\s/g, '');
  }
  let cleaned = raw.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
  return `${cleaned}@c.us`;
};

/**
 * Best-effort string for logs/DB when whatsapp-web.js or Puppeteer throws opaque errors (e.g. message "t").
 */
const formatErrorForLog = (err) => {
  if (err == null) return String(err);
  if (typeof err === 'string') return err;
  const msg = typeof err.message === 'string' ? err.message : '';
  const causeMsg =
    err.cause && typeof err.cause === 'object' && typeof err.cause.message === 'string'
      ? err.cause.message
      : '';
  const code = err.code != null && err.code !== '' ? `code=${err.code}` : '';
  let out = [msg, causeMsg, code].filter(Boolean).join(' | ');
  if (!out || out.length < 4) {
    const stackLine = typeof err.stack === 'string' ? err.stack.split('\n')[1]?.trim() : '';
    if (stackLine) out = msg ? `${msg} — ${stackLine}` : stackLine;
  }
  if (!out) {
    try {
      const s = Object.prototype.toString.call(err);
      if (s && s !== '[object Object]') return s;
    } catch (_) {}
    try {
      return JSON.stringify(err);
    } catch (_) {
      return 'Unknown error';
    }
  }
  return out;
};

/**
 * Generates a random delay between min and max milliseconds
 */
const randomDelay = (min = 20000, max = 30000) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

/**
 * Sleep for a given number of milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { renderTemplate, normalizePhone, randomDelay, sleep, formatErrorForLog };
