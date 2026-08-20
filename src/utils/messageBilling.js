const User = require('../models/User');
const { normalizeMessageSource } = require('./messageSource');

/**
 * Who pays for a send:
 * 1. Owner with an active plan → owner (shared plan quota)
 * 2. Logged-in service account (ehkini/solv) → that account
 * 3. Else source + owner WhatsApp account → matching child login
 * 4. Else the logged-in owner
 */
const resolveBilledUser = async ({ user = null, ownerUserId = null, source = null } = {}) => {
  const parentId = ownerUserId || (user?.parentUserId ? user.parentUserId : (user && !user.parentUserId ? user._id : null));
  const owner = parentId
    ? (user && !user.parentUserId && String(user._id) === String(parentId) ? user : await User.findById(parentId))
    : null;

  if (owner?.planStatus === 'active' && owner.planId) {
    return owner;
  }

  if (user?.parentUserId) return user;

  const sourceName = normalizeMessageSource(source);

  if (sourceName && parentId) {
    const serviceUser = await User.findOne({
      parentUserId: String(parentId),
      source: sourceName,
      isActive: true
    });
    if (serviceUser) return serviceUser;
  }

  if (user) return user;
  return owner || null;
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
