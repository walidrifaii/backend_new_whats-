const authMiddleware = require('./auth');

/**
 * OTP send auth — supports Laravel WHATSAPP_NODE_TOKEN (JWT) or OTP_SERVICE_SECRET.
 *
 * 1. X-Service-Key: <OTP_SERVICE_SECRET>
 * 2. Authorization: Bearer <OTP_SERVICE_SECRET>
 * 3. Authorization: Bearer <user JWT>  (same as WHATSAPP_NODE_TOKEN / /api/messages/send)
 */
const otpAuthMiddleware = (req, res, next) => {
  const secret = String(process.env.OTP_SERVICE_SECRET || '').trim();
  const headerKey = String(req.headers['x-service-key'] || '').trim();
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (secret && (headerKey === secret || bearer === secret)) {
    req.otpAuth = 'service';
    return next();
  }

  if (bearer) {
    req.otpAuth = 'jwt';
    return authMiddleware(req, res, next);
  }

  if (secret) {
    return res.status(401).json({ ok: false, error: 'Invalid service credentials' });
  }

  return res.status(401).json({
    ok: false,
    error:
      'Provide Authorization: Bearer <WHATSAPP_NODE_TOKEN> or set OTP_SERVICE_SECRET and use X-Service-Key'
  });
};

module.exports = otpAuthMiddleware;
