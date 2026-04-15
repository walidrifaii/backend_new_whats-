const Bull = require('bull');
const fs = require('fs');
const path = require('path');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { query } = require('../db/mysql');
const { sendMessage } = require('./whatsappManager');
const { renderTemplate, normalizePhone, sleep, randomDelay } = require('../utils/helpers');
const { emitToClient } = require('../utils/socket');
const { sendBalanceExhaustedEmail } = require('./balanceNotifier');

const logBalanceEmailResult = (context, result, email) => {
  console.log(
    `[BALANCE_EMAIL] context=${context} ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${email || 'n/a'}`
  );
};

const failPendingContacts = async (campaignId, reason) => {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM contacts WHERE campaign_id = ? AND status = 'pending'`,
    [String(campaignId)]
  );
  const pendingCount = rows[0]?.total || 0;
  if (pendingCount <= 0) return { pendingCount: 0, updatedCampaign: null };

  await query(
    `UPDATE contacts
     SET status = 'failed', error = ?
     WHERE campaign_id = ? AND status = 'pending'`,
    [reason, String(campaignId)]
  );

  const updatedCampaign = await Campaign.findByIdAndUpdate(
    campaignId,
    {
      status: 'failed',
      completedAt: new Date(),
      $inc: { failedCount: pendingCount }
    },
    { new: true }
  );

  return { pendingCount, updatedCampaign };
};

// Map of active campaign queues (in-process, not Redis-based for simplicity)
const campaignQueues = new Map();
// Map of paused campaign flags
const pausedCampaigns = new Set();

const getRecoveryFilePath = () => {
  const configured = process.env.CAMPAIGN_RECOVERY_FILE;
  if (configured && String(configured).trim()) {
    return path.resolve(String(configured).trim());
  }
  return path.resolve(__dirname, '../../sessions/.campaign-recovery.json');
};

const readRecoveryCampaignIds = () => {
  const filePath = getRecoveryFilePath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed?.campaignIds)) return [];
    return parsed.campaignIds.map((id) => String(id)).filter(Boolean);
  } catch (err) {
    console.warn(`Failed reading campaign recovery file (${filePath}):`, err.message);
    return [];
  }
};

const writeRecoveryCampaignIds = (campaignIds) => {
  const filePath = getRecoveryFilePath();
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  const uniqueIds = [...new Set(campaignIds.map((id) => String(id)).filter(Boolean))];
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      { campaignIds: uniqueIds, updatedAt: new Date().toISOString() },
      null,
      2
    ),
    'utf8'
  );
};

const removeRecoveryFile = () => {
  const filePath = getRecoveryFilePath();
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  } catch (err) {
    console.warn(`Failed removing campaign recovery file (${filePath}):`, err.message);
  }
};

/**
 * Process a single campaign: iterate through pending contacts,
 * send messages with delay, update progress
 */
const processCampaign = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) return;

  if (campaign.status !== 'running') return;

  const dbClient = await WhatsAppClientModel.findOne({ _id: campaign.clientId, isActive: true });
  if (!dbClient) return;
  const clientId = dbClient.clientId;
  const campaignOwner = await User.findById(dbClient.userId);

  console.log(`🚀 Starting campaign ${campaignId} via client ${clientId}`);

  // Get all pending contacts in batches
  let hasMore = true;

  while (hasMore) {
    // Check if paused or cancelled
    const freshCampaign = await Campaign.findById(campaignId);
    if (!freshCampaign || freshCampaign.status !== 'running') {
      console.log(`Campaign ${campaignId} is no longer running. Stopping.`);
      break;
    }

    // Fetch next batch of pending contacts
    const contacts = await Contact.find(
      { campaignId, status: 'pending' },
      { limit: 10, sort: { createdAt: 1 } }
    );

    if (contacts.length === 0) {
      hasMore = false;
      break;
    }

    for (const contact of contacts) {
      // Re-check pause state before each message
      const current = await Campaign.findById(campaignId);
      if (!current || current.status !== 'running') {
        console.log(`Campaign ${campaignId} paused/stopped mid-send.`);
        return;
      }

      // Check message balance before sending
      const userBalance = await User.getBalance(dbClient.userId);
      if (userBalance <= 0) {
        console.log(`⛔ Campaign ${campaignId} stopped — user has no message balance.`);
        const reason = 'Failed: insufficient message balance. You need to charge balance in message.';
        const { pendingCount, updatedCampaign } = await failPendingContacts(campaignId, reason);
        emitToClient(clientId, 'campaign-balance-exhausted', {
          campaignId,
          message: 'You need to charge balance in message.'
        });
        if (updatedCampaign) {
          emitToClient(clientId, 'campaign-progress', {
            campaignId,
            sentCount: updatedCampaign.sentCount,
            failedCount: updatedCampaign.failedCount,
            totalContacts: updatedCampaign.totalContacts,
            pendingCount: updatedCampaign.pendingCount
          });
        }
        console.log(`Campaign ${campaignId}: marked ${pendingCount} pending contacts as failed.`);
        sendBalanceExhaustedEmail({
          userId: dbClient.userId,
          email: campaignOwner?.email,
          name: campaignOwner?.name
        })
          .then((result) => logBalanceEmailResult('campaign_blocked_zero', result, campaignOwner?.email))
          .catch((err) => logBalanceEmailResult('campaign_blocked_zero', { ok: false, reason: err.message }, campaignOwner?.email));
        return;
      }

      const phone = normalizePhone(contact.phone);
      const variables = {
        name: contact.name || '',
        phone: contact.phone,
        ...((contact.variables && typeof contact.variables === 'object') ? contact.variables : {})
      };
      const renderedMessage = renderTemplate(campaign.message, variables);

      let success = false;
      let error = null;
      let whatsappId = null;

      try {
        const sendOpts =
          campaign.mediaUrl && String(campaign.mediaUrl).trim()
            ? { mediaUrl: campaign.mediaUrl, mediaType: campaign.mediaType || null }
            : null;
        const result = await sendMessage(clientId, phone, renderedMessage, sendOpts);
        whatsappId = result?.id?._serialized || null;
        success = true;
        console.log(`✅ Sent to ${phone} for campaign ${campaignId}`);
      } catch (err) {
        error = err.message;
        console.error(`❌ Failed to send to ${phone}:`, err.message);
      }

      // Decrement user balance on successful send
      if (success) {
        await User.decrementBalance(dbClient.userId, 1);
        const updatedBalance = await User.getBalance(dbClient.userId);
        if (updatedBalance <= 0) {
          sendBalanceExhaustedEmail({
            userId: dbClient.userId,
            email: campaignOwner?.email,
            name: campaignOwner?.name
          })
            .then((result) => logBalanceEmailResult('campaign_reached_zero', result, campaignOwner?.email))
            .catch((err) => logBalanceEmailResult('campaign_reached_zero', { ok: false, reason: err.message }, campaignOwner?.email));
        }
      }

      // Update contact status
      await Contact.findByIdAndUpdate(contact._id, {
        status: success ? 'sent' : 'failed',
        sentAt: success ? new Date() : undefined,
        error: error || undefined
      });

      // Create log entry
      await MessageLog.create({
        userId: dbClient.userId,
        clientId: dbClient._id,
        campaignId,
        contactId: contact._id,
        phone: contact.phone,
        message: renderedMessage,
        direction: 'outgoing',
        status: success ? 'sent' : 'failed',
        whatsappMessageId: whatsappId,
        error: error || undefined
      });

      // Update campaign counters
      const updateFields = success
        ? { $inc: { sentCount: 1 } }
        : { $inc: { failedCount: 1 } };
      const updated = await Campaign.findByIdAndUpdate(campaignId, updateFields, { new: true });

      // Emit progress to frontend
      emitToClient(clientId, 'campaign-progress', {
        campaignId,
        sentCount: updated.sentCount,
        failedCount: updated.failedCount,
        totalContacts: updated.totalContacts,
        pendingCount: updated.totalContacts - updated.sentCount - updated.failedCount
      });

      // Delay between messages (anti-ban)
      const delay = randomDelay(
        campaign.minDelay || parseInt(process.env.MIN_DELAY_MS) || 20000,
        campaign.maxDelay || parseInt(process.env.MAX_DELAY_MS) || 30000
      );
      console.log(`⏳ Waiting ${delay}ms before next message...`);
      await sleep(delay);
    }
  }

  // Mark campaign as completed
  const finalCampaign = await Campaign.findById(campaignId);
  if (finalCampaign && finalCampaign.status === 'running') {
    await Campaign.findByIdAndUpdate(campaignId, {
      status: 'completed',
      completedAt: new Date()
    });
    emitToClient(clientId, 'campaign-completed', { campaignId });
    console.log(`🎉 Campaign ${campaignId} completed`);
  }

  campaignQueues.delete(campaignId.toString());
};

/**
 * Start a campaign
 */
const startCampaign = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  if (campaignQueues.has(campaignId.toString())) {
    throw new Error('Campaign is already running');
  }

  await Campaign.findByIdAndUpdate(campaignId, {
    status: 'running',
    startedAt: campaign.startedAt || new Date()
  });

  // Run campaign in background (non-blocking)
  const promise = processCampaign(campaignId).catch(err => {
    console.error(`Campaign ${campaignId} error:`, err);
    Campaign.findByIdAndUpdate(campaignId, { status: 'failed' }).catch(() => {});
    campaignQueues.delete(campaignId.toString());
  });

  campaignQueues.set(campaignId.toString(), promise);
  return true;
};

/**
 * Pause a campaign
 */
const pauseCampaign = async (campaignId) => {
  await Campaign.findByIdAndUpdate(campaignId, { status: 'paused' });
  campaignQueues.delete(campaignId.toString());
};

/**
 * Resume a paused campaign
 */
const resumeCampaign = async (campaignId) => {
  return startCampaign(campaignId);
};

/**
 * Check if a campaign is currently running
 */
const isCampaignRunning = (campaignId) => {
  return campaignQueues.has(campaignId.toString());
};

const prepareCampaignsForShutdown = async () => {
  const running = await Campaign.find({ status: 'running' });
  if (running.length === 0) {
    removeRecoveryFile();
    return { pausedCount: 0 };
  }

  const pausedIds = [];
  for (const campaign of running) {
    try {
      await Campaign.findByIdAndUpdate(campaign._id, { status: 'paused' });
      campaignQueues.delete(String(campaign._id));
      pausedIds.push(String(campaign._id));
    } catch (err) {
      console.warn(`Failed pausing campaign ${campaign._id} during shutdown:`, err.message);
    }
  }

  if (pausedIds.length > 0) {
    writeRecoveryCampaignIds(pausedIds);
    console.log(`⏸️ Paused ${pausedIds.length} running campaign(s) for safe shutdown.`);
  }

  return { pausedCount: pausedIds.length };
};

const resumeCampaignsAfterBoot = async () => {
  const storedIds = readRecoveryCampaignIds();
  const stillRunningRows = await Campaign.find({ status: 'running' });
  const candidateIds = [...new Set([
    ...storedIds,
    ...stillRunningRows.map((c) => String(c._id))
  ])];

  if (candidateIds.length === 0) {
    return { resumedCount: 0, deferredCount: 0 };
  }

  let resumedCount = 0;
  const deferred = [];

  for (const campaignId of candidateIds) {
    try {
      const campaign = await Campaign.findById(campaignId);
      if (!campaign) continue;

      const isRecoverableStatus = campaign.status === 'paused' || campaign.status === 'running';
      const hasPending = Number(campaign.pendingCount || 0) > 0;
      if (!isRecoverableStatus || !hasPending) continue;

      const dbClient = await WhatsAppClientModel.findOne({ _id: campaign.clientId, isActive: true });
      if (!dbClient || dbClient.status !== 'connected') {
        deferred.push(campaignId);
        continue;
      }

      await startCampaign(campaignId);
      resumedCount += 1;
    } catch (err) {
      console.warn(`Failed auto-resuming campaign ${campaignId}:`, err.message);
      deferred.push(campaignId);
    }
  }

  if (deferred.length > 0) {
    writeRecoveryCampaignIds(deferred);
    console.log(`⏳ Deferred ${deferred.length} campaign(s); will retry on next boot.`);
  } else {
    removeRecoveryFile();
  }

  return { resumedCount, deferredCount: deferred.length };
};

module.exports = {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  isCampaignRunning,
  prepareCampaignsForShutdown,
  resumeCampaignsAfterBoot
};
