const User = require('../models/User');
const { normalizeMessageSource } = require('./messageSource');

/**
 * Who pays for a send:
 * 1. Logged-in service account (ehkini/solv) → that account
 * 2. Else source + owner WhatsApp account → matching child login
 * 3. Else the logged-in owner
 */
const resolveBilledUser = async ({ user = null, ownerUserId = null, source = null } = {}) => {
  if (user?.parentUserId) return user;

  const sourceName = normalizeMessageSource(source);
  const parentId = ownerUserId || (user && !user.parentUserId ? user._id : null);

  if (sourceName && parentId) {
    const serviceUser = await User.findOne({
      parentUserId: String(parentId),
      source: sourceName,
      isActive: true
    });
    if (serviceUser) return serviceUser;
  }

  return user || null;
};

const requireMessageBalance = async (billedUser, required = 1) => {
  if (!billedUser) {
    return { ok: true, balance: null, billedUser: null };
  }
  const balance = await User.getBalance(billedUser._id);
  if (balance < required) {
    return {
      ok: false,
      balance,
      billedUser,
      error: 'You need to charge balance in message.',
      balanceExhausted: true,
      currentBalance: balance,
      required
    };
  }
  return { ok: true, balance, billedUser };
};

const chargeMessageBalance = async (billedUser, amount = 1) => {
  if (!billedUser) return null;
  await User.decrementBalance(billedUser._id, amount);
  return User.getBalance(billedUser._id);
};

module.exports = {
  resolveBilledUser,
  requireMessageBalance,
  chargeMessageBalance
};
