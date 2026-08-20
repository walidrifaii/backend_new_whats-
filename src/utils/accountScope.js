const { normalizeMessageSource } = require('./messageSource');

const getOwnerUserId = (user) => {
  if (!user) return null;
  return user.parentUserId || user._id;
};

const isServiceAccount = (user) => Boolean(user?.parentUserId);

const getLockedSource = (user) => normalizeMessageSource(user?.source);

const applySourceScope = (filter, user, requestedSource, allowedSources = null) => {
  const requested = normalizeMessageSource(requestedSource);
  const locked = getLockedSource(user);
  const allowed = Array.isArray(allowedSources)
    ? allowedSources.map((item) => normalizeMessageSource(item)).filter(Boolean)
    : null;

  if (requested && allowed && allowed.includes(requested)) {
    filter.source = requested;
    return filter;
  }
  if (requested && (!allowed || allowed.length === 0)) {
    filter.source = requested;
    return filter;
  }
  if (locked) {
    filter.source = locked;
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
