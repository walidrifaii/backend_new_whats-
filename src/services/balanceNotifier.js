const nodemailer = require('nodemailer');

const notifyCooldown = new Map();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

const getTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const rawPass = process.env.SMTP_PASS;
  const pass = String(rawPass || '').replace(/[\s_]/g, '');
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  if (!host || !user || !pass) {
    return { transporter: null, reason: 'smtp_not_configured' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });

  return { transporter, reason: 'ok' };
};

const shouldNotify = (userId) => {
  const now = Date.now();
  const last = notifyCooldown.get(String(userId)) || 0;
  if (now - last < COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown_active' };
  }
  notifyCooldown.set(String(userId), now);
  return { ok: true, reason: 'ok' };
};

const sendBalanceExhaustedEmail = async ({ userId, email, name }) => {
  if (!userId || !email) {
    return { ok: false, reason: 'missing_user_or_email' };
  }

  const notifyCheck = shouldNotify(userId);
  if (!notifyCheck.ok) {
    return { ok: false, reason: notifyCheck.reason };
  }

  const { transporter, reason } = getTransporter();
  if (!transporter) {
    return { ok: false, reason };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const displayName = name || 'User';

  try {
    await transporter.sendMail({
      from,
      to: email,
      subject: 'Balance exhausted - charge required',
      text: `Hello ${displayName},\n\nYou used all your message balance.\nYou need to charge balance in message to continue sending.\n\nRegards,\nWhatsApp Marketing SaaS`,
      html: `
        <p>Hello ${displayName},</p>
        <p>You used all your message balance.</p>
        <p><strong>You need to charge balance in message</strong> to continue sending.</p>
        <p>Regards,<br/>WhatsApp Marketing SaaS</p>
      `
    });

    return { ok: true, reason: 'sent' };
  } catch (err) {
    return { ok: false, reason: err.message || 'smtp_send_failed' };
  }
};

module.exports = {
  sendBalanceExhaustedEmail
};

