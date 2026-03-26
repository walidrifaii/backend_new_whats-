const crypto = require('crypto');

const getQrShareSecret = () => String(process.env.QR_SHARE_TOKEN || '').trim();

const buildClientQrToken = (clientId) => {
  const secret = getQrShareSecret();
  if (!secret || !clientId) return '';

  return crypto
    .createHmac('sha256', secret)
    .update(String(clientId))
    .digest('hex');
};

const isClientQrTokenValid = (clientId, providedToken) => {
  const expected = buildClientQrToken(clientId);
  const provided = String(providedToken || '').trim();
  if (!expected || !provided) return false;

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
};

module.exports = {
  buildClientQrToken,
  isClientQrTokenValid
};
