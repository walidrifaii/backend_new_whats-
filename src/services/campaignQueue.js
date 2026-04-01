const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const { sendMessage, sendImageMessage } = require('./whatsappManager');
const { renderTemplate, normalizePhone, sleep, randomDelay } = require('../utils/helpers');
const { emitToClient } = require('../utils/socket');

// Map of active campaign promises (in-process)
const campaignQueues = new Map();

/**
 * Process a single campaign: iterate through pending contacts,
 * send messages (with optional image) with delay, update progress.
 */
const processCampaign = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId).populate('clientId');
  if (!campaign) return;
  if (campaign.status !== 'running') return;

  const dbClient = campaign.clientId;
  const clientId = dbClient.clientId;

  // Determine if this campaign sends an image
  const hasImage = !!(campaign.mediaUrl && campaign.mediaType === 'image');

  console.log(`🚀 Starting campaign ${campaignId} via client ${clientId} [image: ${hasImage}]`);

  let hasMore = true;

  while (hasMore) {
    // Check if paused or cancelled
    const freshCampaign = await Campaign.findById(campaignId);
    if (!freshCampaign || freshCampaign.status !== 'running') {
      console.log(`Campaign ${campaignId} is no longer running. Stopping.`);
      break;
    }

    // Fetch next batch of pending contacts
    const contacts = await Contact.find({ campaignId, status: 'pending' }).limit(10);

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

      const phone = normalizePhone(contact.phone);
      const variables = {
        name: contact.name || '',
        phone: contact.phone,
        ...(contact.variables ? Object.fromEntries(contact.variables) : {})
      };

      // Render both message and caption (caption is used when sending image)
      const renderedMessage = renderTemplate(campaign.message, variables);
      const renderedCaption = campaign.imageCaption
        ? renderTemplate(campaign.imageCaption, variables)
        : renderedMessage; // fall back to message if no dedicated caption

      let success = false;
      let error = null;
      let whatsappId = null;

      try {
        let result;

        if (hasImage) {
          // Send image with caption
          result = await sendImageMessage(clientId, phone, campaign.mediaUrl, renderedCaption);
        } else {
          // Text-only message
          result = await sendMessage(clientId, phone, renderedMessage);
        }

        whatsappId = result?.id?._serialized || null;
        success = true;
        console.log(`✅ Sent to ${phone} for campaign ${campaignId}`);
      } catch (err) {
        error = err.message;
        console.error(`❌ Failed to send to ${phone}:`, err.message);
      }

      // Update contact status
      await Contact.findByIdAndUpdate(contact._id, {
        status: success ? 'sent' : 'failed',
        sentAt: success ? new Date() : undefined,
        error: error || undefined
      });

      // The log message: prefer caption for images so it reflects what was shown
      const logMessage = hasImage
        ? `[image] ${renderedCaption || campaign.mediaUrl}`
        : renderedMessage;

      // Create log entry
      await MessageLog.create({
        userId: dbClient.userId,
        clientId: dbClient._id,
        campaignId,
        contactId: contact._id,
        phone: contact.phone,
        message: logMessage,
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
