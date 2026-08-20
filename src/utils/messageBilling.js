const User = require('../models/User');
const { normalizeMessageSource } = require('./messageSource');

const hasActivePlan = (account) => Boolean(account?.planStatus === 'active' && account.planId);

/**
 * Who pays for a send:
 * 1. Source/service login with its own active plan
 * 2. Owner with an active plan
 * 3. Matching source login (extra balance)
 * 4. Logged-in user / owner
 * WhatsApp always stays on the owner.
 */
const resolveBilledUser = async ({ user = null, ownerUserId = null, source = null } = {}) => {
  const parentId = ownerUserId || (user?.parentUserId ? user.parentUserId : (user && !user.parentUserId ? user._id : null));
  const owner = parentId
    ? (user && !user.parentUserId && String(user._id) === String(parentId) ? user : await User.findById(parentId))
    : null;

  const sourceName = normalizeMessageSource(source) || normalizeMessageSource(user?.source);
  let serviceUser = null;
  if (user?.parentUserId) {
    serviceUser = user;
  } else if (sourceName && parentId) {
    serviceUser = await User.findOne({
      parentUserId: String(parentId),
      source: sourceName,
      isActive: true
    });
  }

  if (hasActivePlan(serviceUser)) return serviceUser;
  if (hasActivePlan(owner)) return owner;
  if (serviceUser) return serviceUser;
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
