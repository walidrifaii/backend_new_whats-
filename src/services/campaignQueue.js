const Bull = require('bull');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { query } = require('../db/mysql');
const { sendMessage } = require('./whatsappManager');
const { renderTemplate, normalizePhone, sleep, randomDelay, formatErrorForLog } = require('../utils/helpers');
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
      const renderedMessage = renderTemplate(
        current.message || '',
        variables
      );
      const mediaUrl = (current.mediaUrl && String(current.mediaUrl).trim()) || null;

      let success = false;
      let error = null;
      let whatsappId = null;

      try {
        const result = await sendMessage(
          clientId,
          phone,
          renderedMessage,
          mediaUrl
        );
        whatsappId = result?.id?._serialized || null;
        success = true;
        console.log(`✅ Sent to ${phone} for campaign ${campaignId}`);
      } catch (err) {
        error = formatErrorForLog(err);
        console.error(`❌ Failed to send to ${phone}:`, error);
        if (typeof err?.stack === 'string' && err.stack.length > 80) {
          console.error(err.stack.split('\n').slice(0, 4).join('\n'));
        }
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

module.exports = {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  isCampaignRunning
};
