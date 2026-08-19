const { normalizeMessageSource } = require('./messageSource');

const getOwnerUserId = (user) => {
  if (!user) return null;
  return user.parentUserId || user._id;
};

const isServiceAccount = (user) => Boolean(user?.parentUserId);

const getLockedSource = (user) => normalizeMessageSource(user?.source);

const applySourceScope = (filter, user, requestedSource) => {
  const locked = getLockedSource(user);
  if (locked) {
    filter.source = locked;
    return filter;
  }
  const source = normalizeMessageSource(requestedSource);
  if (source) filter.source = source;
  return filter;
};

module.exports = {
  getOwnerUserId,
  isServiceAccount,
  getLockedSource,
  applySourceScope
};
