const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const App = require('../models/App');
const { getOwnerUserId } = require('./accountScope');
const { normalizeMessageSource } = require('./messageSource');

const hasActivePlan = (account) => Boolean(account?.planStatus === 'active' && account.planId);

/**
 * Who pays for a send (legacy user-plan path, kept for old rows):
 * 1. Source/service login with its own active plan
 * 2. Owner with an active plan
 * 3. Matching source login (extra balance)
 * 4. Logged-in user / owner
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

const resolveBilledApp = async ({ user = null, ownerUserId = null, source = null } = {}) => {
  const ownerId = ownerUserId || getOwnerUserId(user);
  if (!ownerId) return null;
  const owner = user && String(user._id) === String(ownerId) ? user : await User.findById(ownerId);
  return App.resolveForSend(ownerId, {
    source: source || user?.source,
    currentAppId: owner?.currentAppId,
    allowSwitch: Boolean(owner?.allowSourceSwitch)
  });
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

const requireNumberBalance = async (dbClient, required = 1) => {
  if (!dbClient) {
    return { ok: true, balance: null, billedClient: null };
  }
  const fresh = await WhatsAppClientModel.findOne({ _id: dbClient._id });
  const balance = Number(fresh?.messageBalance ?? dbClient.messageBalance ?? 0);
  if (balance < required) {
    return {
      ok: false,
      balance,
      billedClient: fresh || dbClient,
      error: 'You need to charge balance in message.',
      balanceExhausted: true,
      currentBalance: balance,
      required
    };
  }
  return { ok: true, balance, billedClient: fresh || dbClient };
};

const chargeNumberBalance = async (dbClient, amount = 1) => {
  if (!dbClient) return null;
  return WhatsAppClientModel.decrementBalance(dbClient._id, amount);
};

const requireAppBalance = async (app, required = 1) => {
  if (!app) {
    return { ok: true, balance: null, billedApp: null };
  }
  const fresh = await App.findById(app._id);
  const balance = Number(fresh?.balance ?? app.balance ?? 0);
  if (balance < required) {
    return {
      ok: false,
      balance,
      billedApp: fresh || app,
      error: 'You need to charge balance in message.',
      balanceExhausted: true,
      currentBalance: balance,
      required
    };
  }
  return { ok: true, balance, billedApp: fresh || app };
};

const chargeAppBalance = async (app, amount = 1) => {
  if (!app) return null;
  return App.decrementBalance(app._id, amount);
};

const requireSendBalance = async ({ user, dbClient, source, required = 1 } = {}) => {
  let app = await resolveBilledApp({ user, source });
  // If App exists but was never topped up, copy credits from the OTP number.
  if (app && dbClient) {
    const appBal = Number(app.balance) || 0;
    const numBal = Number(dbClient.messageBalance) || 0;
    if (appBal < required && numBal > appBal) {
      await App.setBalance(app._id, numBal);
      app = await App.findById(app._id);
    }
  }
  if (app) return requireAppBalance(app, required);
  return requireNumberBalance(dbClient, required);
};

const chargeSendBalance = async ({ user, dbClient, source, amount = 1 } = {}) => {
  const app = await resolveBilledApp({ user, source });
  if (app) {
    const updated = await chargeAppBalance(app, amount);
    if (dbClient) {
      await chargeNumberBalance(dbClient, amount);
    }
    return Number(updated?.balance) || 0;
  }
  return chargeNumberBalance(dbClient, amount);
};

module.exports = {
  resolveBilledUser,
  resolveBilledApp,
  requireMessageBalance,
  chargeMessageBalance,
  requireNumberBalance,
  chargeNumberBalance,
  requireAppBalance,
  chargeAppBalance,
  requireSendBalance,
  chargeSendBalance
};
