const User = require('../models/User');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { getTransporter } = require('../utils/smtp');

const notifyCooldown = new Map();

const isEnabled = () =>
  String(process.env.WHATSAPP_DISCONNECT_EMAIL_ENABLED || 'true').toLowerCase() !== 'false';

const getCooldownMs = () => {
  const n = parseInt(process.env.WHATSAPP_DISCONNECT_EMAIL_COOLDOWN_MS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
};

const shouldNotify = (userId, clientId) => {
  const key = `${String(userId)}:${String(clientId)}`;
  const now = Date.now();
  const last = notifyCooldown.get(key) || 0;
  const cooldownMs = getCooldownMs();
  if (cooldownMs > 0 && now - last < cooldownMs) {
    return { ok: false, reason: 'cooldown_active' };
  }
  notifyCooldown.set(key, now);
  return { ok: true, reason: 'ok' };
};

const logResult = (context, result, email, clientId) => {
  console.log(
    `[DISCONNECT_EMAIL] context=${context} client=${clientId || 'n/a'} ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${email || 'n/a'}`
  );
};

/**
 * Email the client owner when a WhatsApp session goes offline unexpectedly.
 * @param {'disconnected'|'auth_failure'} eventType
 */
const sendWhatsAppDisconnectedEmail = async ({
  clientId,
  reason = '',
  eventType = 'disconnected'
}) => {
  if (!isEnabled()) {
    return { ok: false, reason: 'notifications_disabled' };
  }

  const dbClient = await WhatsAppClientModel.findOne({ clientId, isActive: true });
  if (!dbClient) {
    return { ok: false, reason: 'client_not_found' };
  }

  const user = await User.findById(dbClient.userId);
  if (!user?.email) {
    return { ok: false, reason: 'missing_user_or_email' };
  }

  const notifyCheck = shouldNotify(dbClient.userId, clientId);
  if (!notifyCheck.ok) {
    return { ok: false, reason: notifyCheck.reason };
  }

  const { transporter, reason: smtpReason } = getTransporter();
  if (!transporter) {
    return { ok: false, reason: smtpReason };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const displayName = user.name || 'User';
  const clientLabel = dbClient.name || clientId;
  const phone = dbClient.phone ? ` (${dbClient.phone})` : '';
  const reasonText = reason ? `\nReason: ${reason}` : '';
  const isAuthFailure = eventType === 'auth_failure';

  const subject = isAuthFailure
    ? `WhatsApp auth failed — ${clientLabel}`
    : `WhatsApp disconnected — ${clientLabel}`;

  const bodyIntro = isAuthFailure
    ? `Your WhatsApp client "${clientLabel}"${phone} failed authentication and was logged out.`
    : `Your WhatsApp client "${clientLabel}"${phone} was disconnected from the server.`;

  const actionLine =
    'Please open your dashboard and reconnect the client (scan QR if required) to resume sending messages.';

  try {
    await transporter.sendMail({
      from,
      to: user.email,
      subject,
      text: `Hello ${displayName},\n\n${bodyIntro}${reasonText}\n\n${actionLine}\n\nRegards,\nWhatsApp Marketing SaaS`,
      html: `
        <p>Hello ${displayName},</p>
        <p>${bodyIntro}</p>
        ${reason ? `<p><strong>Reason:</strong> ${String(reason).replace(/</g, '&lt;')}</p>` : ''}
        <p>${actionLine}</p>
        <p>Regards,<br/>WhatsApp Marketing SaaS</p>
      `
    });

    return { ok: true, reason: 'sent' };
  } catch (err) {
    return { ok: false, reason: err.message || 'smtp_send_failed' };
  }
};

const notifyWhatsAppDisconnected = ({ clientId, reason, eventType }) => {
  sendWhatsAppDisconnectedEmail({ clientId, reason, eventType })
    .then((result) => logResult(eventType, result, null, clientId))
    .catch((err) => logResult(eventType, { ok: false, reason: err.message }, null, clientId));
};

module.exports = {
  sendWhatsAppDisconnectedEmail,
  notifyWhatsAppDisconnected
};
