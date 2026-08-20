const { normalizeMessageSource } = require('./messageSource');

const getOwnerUserId = (user) => {
  if (!user) return null;
  return user.parentUserId || user._id;
};

const isServiceAccount = (user) => Boolean(user?.parentUserId);

const getLockedSource = (user) => normalizeMessageSource(user?.source);

const applySourceScope = (filter, user, requestedSource, allowedSources = null) => {
  const locked = getLockedSource(user);
  if (locked) {
    filter.source = locked;
    return filter;
  }

  const requested = normalizeMessageSource(requestedSource);
  const allowed = Array.isArray(allowedSources)
    ? allowedSources.map((item) => normalizeMessageSource(item)).filter(Boolean)
    : null;

  if (requested && allowed && allowed.length > 0 && !allowed.includes(requested)) {
    return filter;
  }
  if (requested) filter.source = requested;
  return filter;
};

module.exports = {
  getOwnerUserId,
  isServiceAccount,
  getLockedSource,
  applySourceScope
};
