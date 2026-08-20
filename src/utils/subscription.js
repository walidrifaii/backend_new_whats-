const Plan = require('../models/Plan');
const User = require('../models/User');
const UserSource = require('../models/UserSource');
const { getOwnerUserId } = require('./accountScope');
const { normalizeMessageSource } = require('./messageSource');

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
      remaining: 0
    };
  }

  const owner = typeof userOrOwnerId === 'object' && !userOrOwnerId.parentUserId
    ? userOrOwnerId
    : await User.findById(ownerId);
  const plan = owner?.planId ? await Plan.findById(owner.planId) : null;
  const sources = await UserSource.listByUser(ownerId);
  const enabledSources = sources.filter((row) => row.enabled).map((row) => row.source);
  const knownSources = await UserSource.listKnownNames(ownerId);
  const status = owner?.planStatus || 'none';

  return {
    owner,
    plan: status === 'active' ? plan : null,
    requestedPlan: plan,
    status,
    sources,
    enabledSources,
    knownSources,
    remaining: owner?.messageBalance ?? 0,
    sourceLimit: plan?.sourceLimit || 0
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
  const plan = fresh?.planId ? await Plan.findById(fresh.planId) : null;
  const status = fresh?.planStatus || 'none';
  return {
    owner: ownerSub.owner,
    billedUser: fresh,
    plan: status === 'active' ? plan : null,
    requestedPlan: plan,
    status,
    sources: ownerSub.sources,
    enabledSources: ownerSub.enabledSources,
    knownSources: ownerSub.knownSources,
    remaining: fresh?.messageBalance ?? 0,
    sourceLimit: 0,
    sharesOwnerWhatsApp: true
  };
};

const serializeSubscription = (sub, user = null) => {
  const currentSource = normalizeMessageSource(user?.source);
  const isService = Boolean(user?.parentUserId || sub.sharesOwnerWhatsApp);
  const sourceLimit = isService ? 0 : (sub.sourceLimit || sub.plan?.sourceLimit || 0);
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
  return {
    plan: mapPlan(sub.plan),
    requestedPlan: sub.status === 'pending' ? mapPlan(sub.requestedPlan) : null,
    status: sub.status || 'none',
    remaining: sub.remaining || 0,
    enabledSources: sub.enabledSources || [],
    sourceLimit,
    catalog: sub.enabledSources || [],
    sharesOwnerWhatsApp: isService,
    currentSourceEnabled: currentSource
      ? (sub.enabledSources || []).includes(currentSource)
      : true
  };
};

// On/off is display-only (stats/logs). Sending OTP and other messages
// must still work when a source is off.
const assertSourceAllowed = (_sub, source) => {
  return { ok: true, source: normalizeMessageSource(source) };
};

const assignPlanToUser = async (user, plan, { refillBalance = true } = {}) => {
  await User.setPlan(user._id, plan._id, 'active');
  if (refillBalance) {
    await User.updateBalance(user._id, plan.messageQuota);
  }
  if (!user.parentUserId) {
    const enabledCount = await UserSource.countEnabled(user._id);
    if (enabledCount > plan.sourceLimit) {
      const sources = await UserSource.listByUser(user._id);
      const enabled = sources.filter((row) => row.enabled);
      for (const extra of enabled.slice(plan.sourceLimit)) {
        await UserSource.upsert({ userId: user._id, source: extra.source, enabled: false });
      }
    }
  }
  return getAccountSubscription(user._id);
};

const assignPlanToOwner = assignPlanToUser;

module.exports = {
  getOwnerSubscription,
  getAccountSubscription,
  serializeSubscription,
  assertSourceAllowed,
  assignPlanToUser,
  assignPlanToOwner
};
