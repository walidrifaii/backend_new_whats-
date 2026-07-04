const { getTransporter } = require('../utils/smtp');

const notifyCooldown = new Map();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

const shouldNotify = (userId) => {  const now = Date.now();
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

  const { transporter, reason, from: mailFrom } = getTransporter();
  if (!transporter) {
    return { ok: false, reason };
  }

  const from = mailFrom || process.env.SMTP_FROM || process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER;
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

