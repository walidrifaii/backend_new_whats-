/**
 * Authenticates server-to-server calls (e.g. Laravel forgot-password → WhatsApp Node).
 * Accepts OTP_SERVICE_SECRET via:
 *   - Header: X-Service-Key: <secret>
 *   - Header: Authorization: Bearer <secret>
 */
const serviceAuthMiddleware = (req, res, next) => {
  const secret = String(process.env.OTP_SERVICE_SECRET || '').trim();
  if (!secret) {
    return res.status(503).json({
      ok: false,
      error: 'OTP service is not configured. Set OTP_SERVICE_SECRET in environment.'
    });
  }

  const headerKey = String(req.headers['x-service-key'] || '').trim();
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (headerKey === secret || bearer === secret) {
    return next();
  }

  return res.status(401).json({ ok: false, error: 'Invalid service credentials' });
};

module.exports = serviceAuthMiddleware;
