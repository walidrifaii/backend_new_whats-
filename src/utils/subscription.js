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

const serializeSubscription = (sub, user = null) => {
  const currentSource = normalizeMessageSource(user?.source);
  return {
    plan: sub.plan
      ? {
          _id: sub.plan._id,
          name: sub.plan.name,
          slug: sub.plan.slug,
          messageQuota: sub.plan.messageQuota,
          sourceLimit: sub.plan.sourceLimit
        }
      : null,
    requestedPlan: sub.status === 'pending' && sub.requestedPlan
      ? {
          _id: sub.requestedPlan._id,
          name: sub.requestedPlan.name,
          slug: sub.requestedPlan.slug,
          messageQuota: sub.requestedPlan.messageQuota,
          sourceLimit: sub.requestedPlan.sourceLimit
        }
      : null,
    status: sub.status || 'none',
    remaining: sub.remaining || 0,
    enabledSources: sub.enabledSources || [],
    sourceLimit: sub.sourceLimit || 0,
    catalog: sub.enabledSources || [],
    currentSourceEnabled: currentSource
      ? (sub.enabledSources || []).includes(currentSource)
      : true
  };
};

const assertSourceAllowed = (sub, source) => {
  const sourceName = normalizeMessageSource(source);
  const enabled = sub.enabledSources || [];
  const activePlan = sub.status === 'active' && sub.plan;

  if (!activePlan && enabled.length === 0) {
    return { ok: true, source: sourceName };
  }

  if (activePlan && enabled.length === 0) {
    return {
      ok: false,
      error: 'No sources are enabled on this plan. Ask an admin to enable a source.'
    };
  }

  if (!sourceName) {
    if (enabled.length > 0) {
      return { ok: false, error: 'source is required.' };
    }
    return { ok: true, source: null };
  }

  if (enabled.length > 0 && !enabled.includes(sourceName)) {
    return {
      ok: false,
      error: `Source "${sourceName}" is not enabled on this account.`
    };
  }

  return { ok: true, source: sourceName };
};

const assignPlanToOwner = async (owner, plan, { refillBalance = true } = {}) => {
  await User.setPlan(owner._id, plan._id, 'active');
  if (refillBalance) {
    await User.updateBalance(owner._id, plan.messageQuota);
  }
  const enabledCount = await UserSource.countEnabled(owner._id);
  if (enabledCount > plan.sourceLimit) {
    const sources = await UserSource.listByUser(owner._id);
    const enabled = sources.filter((row) => row.enabled);
    for (const extra of enabled.slice(plan.sourceLimit)) {
      await UserSource.upsert({ userId: owner._id, source: extra.source, enabled: false });
    }
  }
  return getOwnerSubscription(owner._id);
};

module.exports = {
  getOwnerSubscription,
  serializeSubscription,
  assertSourceAllowed,
  assignPlanToOwner
};
