const nodemailer = require('nodemailer');

/**
 * Supports Node (SMTP_*) and Laravel-style (MAIL_*) environment variables.
 */
const readSmtpConfig = () => {
  const host = process.env.SMTP_HOST || process.env.MAIL_HOST;
  const port = parseInt(process.env.SMTP_PORT || process.env.MAIL_PORT || '587', 10);
  const user = process.env.SMTP_USER || process.env.MAIL_USERNAME;
  const rawPass = process.env.SMTP_PASS || process.env.MAIL_PASSWORD;
  const pass = String(rawPass || '').replace(/\s/g, '');
  const encryption = String(
    process.env.MAIL_ENCRYPTION || process.env.SMTP_ENCRYPTION || ''
  ).toLowerCase();

  let secure;
  if (process.env.SMTP_SECURE !== undefined && String(process.env.SMTP_SECURE).trim() !== '') {
    secure = String(process.env.SMTP_SECURE).toLowerCase() === 'true';
  } else if (encryption === 'ssl' || encryption === 'smtps') {
    // ssl on 465 = implicit TLS; ssl on 587 often still uses STARTTLS
    secure = port === 465;
  } else {
    secure = port === 465;
  }

  const fromAddress =
    process.env.SMTP_FROM ||
    process.env.MAIL_FROM_ADDRESS ||
    user;

  const fromNameRaw = process.env.MAIL_FROM_NAME || process.env.SMTP_FROM_NAME || '';
  const fromName = String(fromNameRaw).replace(/^["']|["']$/g, '').trim();

  const from = fromName && fromAddress
    ? `"${fromName}" <${fromAddress}>`
    : fromAddress;

  const rejectUnauthorized =
    String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false';

  return {
    host,
    port,
    user,
    pass,
    secure,
    from,
    requireTLS: !secure && port === 587,
    tls: { rejectUnauthorized }
  };
};

const getTransporter = () => {
  const cfg = readSmtpConfig();

  if (!cfg.host || !cfg.user || !cfg.pass) {
    return { transporter: null, reason: 'smtp_not_configured', from: null };
  }

  const options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: cfg.tls
  };

  if (cfg.requireTLS) {
    options.requireTLS = true;
  }

  const transporter = nodemailer.createTransport(options);

  return { transporter, reason: 'ok', from: cfg.from };
};

const isSmtpConfigured = () => getTransporter().transporter !== null;

const getMailFrom = () => getTransporter().from;

module.exports = {
  readSmtpConfig,
  getTransporter,
  getMailFrom,
  isSmtpConfigured
};
