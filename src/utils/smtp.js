const nodemailer = require('nodemailer');

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

const isSmtpConfigured = () => getTransporter().transporter !== null;

module.exports = {
  getTransporter,
  isSmtpConfigured
};
