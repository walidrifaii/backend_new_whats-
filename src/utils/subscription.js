const Plan = require('../models/Plan');
const User = require('../models/User');
const UserSource = require('../models/UserSource');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const App = require('../models/App');
const { getOwnerUserId } = require('./accountScope');
const { normalizeMessageSource } = require('./messageSource');

const getAssignedNumbers = async (ownerId) => {
  if (!ownerId) return [];
  return WhatsAppClientModel.find({ userId: ownerId, isActive: true }, { sort: { createdAt: -1 } });
};

const planFromNumbers = async (numbers) => {
  const plans = [];
  for (const number of numbers) {
    if (!number.planId || number.planStatus !== 'active') continue;
    const plan = await Plan.findById(number.planId);
    if (plan) plans.push({ number, plan });
  }
  const remaining = numbers.reduce((sum, item) => sum + (Number(item.messageBalance) || 0), 0);
  const sourceLimit = plans.reduce((max, item) => Math.max(max, item.plan.sourceLimit || 0), 0);
  const primary = plans[0] || null;
  return {
    plan: primary?.plan || null,
    remaining,
    sourceLimit
  };
};

const getOwnerSubscription = async (userOrOwnerId) => {
  const ownerId = typeof userOrOwnerId === 'object'
    ? getOwnerUserId(userOrOwnerId)
    : userOrOwnerId;
  if (!ownerId) {
    return {
      owner: null,
      plan: null,
      status: 'none',
      sources: [],
      enabledSources: [],
      knownSources: [],
      remaining: 0,
      allowSourceSwitch: false,
      enabledServices: []
    };
  }

  const owner = typeof userOrOwnerId === 'object' && !userOrOwnerId.parentUserId
    ? userOrOwnerId
    : await User.findById(ownerId);
  const numbers = await getAssignedNumbers(ownerId);
  const fromNumbers = await planFromNumbers(numbers);
  const status = fromNumbers.plan ? 'active' : 'none';
  const sources = await UserSource.list(ownerId);
  const apps = await App.listForClient(ownerId);
  const enabledSources = sources.filter((item) => item.enabled).map((item) => item.name);
  const enabledServices = sources.filter((item) => item.enabled);
  const appRemaining = apps.reduce((sum, item) => sum + (Number(item.balance) || 0), 0);
  // Prefer App balances when charged there; fall back to OTP number balances if Apps are still 0.
  const remaining = Math.max(appRemaining, fromNumbers.remaining);

  return {
    owner,
    numbers,
    apps,
    plan: fromNumbers.plan,
    requestedPlan: fromNumbers.plan,
    status,
    sources,
    enabledSources,
    enabledServices,
    knownSources: enabledSources,
    remaining,
    sourceLimit: fromNumbers.sourceLimit,
    allowSourceSwitch: Boolean(owner?.allowSourceSwitch) || apps.filter((item) => item.isActive).length >= 2,
    currentAppId: owner?.currentAppId || null,
    canLogin: numbers.length > 0
  };
};

const getAccountSubscription = async (userOrId) => {
  const user = typeof userOrId === 'object' && userOrId?._id
    ? userOrId
    : await User.findById(userOrId);
  if (!user) {
    return getOwnerSubscription(null);
  }
  if (!user.parentUserId) {
    const sub = await getOwnerSubscription(user);
    return { ...sub, sharesOwnerWhatsApp: false };
  }

  const fresh = await User.findById(user._id);
  const ownerSub = await getOwnerSubscription(user.parentUserId);
  return {
    owner: ownerSub.owner,
    billedUser: fresh,
    numbers: ownerSub.numbers,
    apps: ownerSub.apps,
    plan: ownerSub.plan,
    requestedPlan: ownerSub.requestedPlan,
    status: ownerSub.status,
    sources: ownerSub.sources,
    enabledSources: ownerSub.enabledSources,
    enabledServices: ownerSub.enabledServices,
    knownSources: ownerSub.knownSources,
    remaining: ownerSub.remaining,
    sourceLimit: 0,
    allowSourceSwitch: Boolean(ownerSub.allowSourceSwitch) && !fresh.source,
    currentAppId: ownerSub.currentAppId,
    sharesOwnerWhatsApp: true,
    canLogin: (ownerSub.numbers || []).length > 0
  };
};

const serializeSubscription = (sub, user = null) => {
  const isService = Boolean(user?.parentUserId || sub.sharesOwnerWhatsApp);
  const sourceLimit = isService ? 0 : (sub.sourceLimit || sub.plan?.sourceLimit || 0);
  const enabledSources = sub.enabledSources || [];
  const catalog = sub.sources || [];
  const mapPlan = (plan) => (
    plan
      ? {
          _id: plan._id,
          name: plan.name,
          slug: plan.slug,
          messageQuota: plan.messageQuota,
          sourceLimit: isService ? 0 : plan.sourceLimit
        }
      : null
  );
  const activeApps = (sub.apps || []).filter((item) => item.isActive);
  const canSwitch = activeApps.length >= 2 && !user?.source;
  return {
    plan: mapPlan(sub.plan),
    requestedPlan: sub.status === 'pending' ? mapPlan(sub.requestedPlan) : null,
    status: sub.status || 'none',
    remaining: sub.remaining || 0,
    sources: catalog,
    apps: sub.apps || [],
    currentAppId: sub.currentAppId || user?.currentAppId || null,
    enabledSources,
    enabledServices: catalog.filter((item) => item.enabled),
    sourceLimit,
    catalog,
    allowSourceSwitch: canSwitch || Boolean(sub.allowSourceSwitch),
    canSwitchSources: canSwitch,
    canLogin: Boolean(sub.canLogin) || (sub.numbers || []).length > 0,
    numberCount: (sub.numbers || []).length,
    sharesOwnerWhatsApp: isService,
    currentSourceEnabled: true
  };
};

const assertSourceAllowed = (sub, source) => {
  const name = normalizeMessageSource(source);
  const catalog = sub?.sources || [];
  if (!name || catalog.length === 0) {
    return { ok: true, source: name };
  }
  const row = catalog.find((item) => item.name === name);
  if (!row) {
    return { ok: false, error: `Source "${name}" is not configured for this account.`, source: name };
  }
  if (!row.enabled) {
    return { ok: false, error: `Source "${name}" is not allowed.`, source: name };
  }
  return { ok: true, source: name };
};

const assignPlanToUser = async (user, plan, { refillBalance = true } = {}) => {
  await User.setPlan(user._id, plan._id, 'active');
  if (refillBalance) {
    await User.updateBalance(user._id, plan.messageQuota);
  }
  return getAccountSubscription(user._id);
};

const assignPlanToOwner = assignPlanToUser;

const assignPlanToNumber = async (client, plan, { refillBalance = true } = {}) => {
  if (!plan) {
    await WhatsAppClientModel.setPlan(client._id, null, 'none');
    return WhatsAppClientModel.findOne({ _id: client._id });
  }
  await WhatsAppClientModel.setPlan(client._id, plan._id, 'active');
  if (refillBalance) {
    await WhatsAppClientModel.updateBalance(client._id, plan.messageQuota);
  }
  return WhatsAppClientModel.findOne({ _id: client._id });
};

module.exports = {
  getOwnerSubscription,
  getAccountSubscription,
  serializeSubscription,
  assertSourceAllowed,
  assignPlanToUser,
  assignPlanToOwner,
  assignPlanToNumber,
  getAssignedNumbers
};
