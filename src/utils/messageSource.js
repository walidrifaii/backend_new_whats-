const MAX_SOURCE_LENGTH = 64;

const normalizeMessageSource = (raw) => {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  const cleaned = value.replace(/[^a-z0-9._-]/g, '').slice(0, MAX_SOURCE_LENGTH);
  return cleaned || null;
};

const resolveMessageSource = (req) =>
  normalizeMessageSource(
    req.body?.source ||
      req.body?.service ||
      req.headers['x-service-name'] ||
      req.headers['x-otp-source']
  );

module.exports = {
  normalizeMessageSource,
  resolveMessageSource
};
