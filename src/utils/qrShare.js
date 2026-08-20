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

const buildQrSharePayload = (req, clientId) => {
  const token = buildClientQrToken(clientId);
  if (!token || !clientId) return null;

  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!host) return null;
  const baseUrl = `${proto}://${host}`;
  return {
    clientId,
    token,
    pageUrl: `${baseUrl}/public/qr/${clientId}?token=${token}`,
    imageUrl: `${baseUrl}/public/qr/${clientId}.png?token=${token}`
  };
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
  buildQrSharePayload,
  isClientQrTokenValid
};
