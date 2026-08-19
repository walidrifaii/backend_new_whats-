const MessageJob = require('../models/MessageJob');
const MessageJobItem = require('../models/MessageJobItem');
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { sendMessage, isClientConnected, waitForClientReady } = require('./whatsappManager');
const { normalizePhone, sleep } = require('../utils/helpers');
const { emitToClient } = require('../utils/socket');
const { sendBalanceExhaustedEmail } = require('./balanceNotifier');
const { getOwnerUserId } = require('../utils/accountScope');

const POLL_MS = Math.max(5000, parseInt(process.env.BULK_SCHEDULER_POLL_MS, 10) || 30000);

const activeJobsByClient = new Map();
const runningJobPromises = new Map();

const logBalanceEmailResult = (context, result, email) => {
  console.log(
    `[BALANCE_EMAIL] context=${context} ok=${result?.ok ? 'true' : 'false'} reason=${result?.reason || 'unknown'} email=${email || 'n/a'}`
  );
};

const buildLogText = (message, mediaUrl) => {
  const parts = [message, mediaUrl && `(media: ${mediaUrl})`].filter(Boolean);
  return parts.join(' ') || '(media only)';
};

const failPendingItems = async (jobId, reason) => {
  const pendingCount = await MessageJobItem.failPendingByJobId(jobId, reason);
  if (pendingCount <= 0) return null;

  return MessageJob.findByIdAndUpdate(
    jobId,
    {
      status: 'failed',
      completedAt: new Date(),
      $inc: { failedCount: pendingCount }
    },
    { new: true }
  );
};

const waitForItemSchedule = async (item) => {
  if (!item?.scheduledAt) return;
  const waitMs = new Date(item.scheduledAt).getTime() - Date.now();
  if (waitMs <= 0) return;
  const chunk = Math.min(waitMs, POLL_MS);
  console.log(`⏳ Next send for ${item.phone} in ${Math.ceil(waitMs / 1000)}s`);
  await sleep(chunk);
};

const processMessageJob = async (jobId) => {
  const job = await MessageJob.findById(jobId);
  if (!job) return;

  if (!['queued', 'running'].includes(job.status)) return;

  const dbClient = await WhatsAppClientModel.findOne({ _id: job.clientId, isActive: true });
  if (!dbClient) {
    await failPendingItems(jobId, 'WhatsApp client not found or inactive');
    return;
  }

  const sessionClientId = dbClient.clientId;
  const jobOwner = await User.findById(job.userId);
  const logOwnerId = getOwnerUserId(jobOwner) || job.userId;
  const logSource = jobOwner?.source || null;

  if (!isClientConnected(sessionClientId)) {
    const reason =
      'WhatsApp session is not active on the server. Reconnect the client from the dashboard (status may show connected in DB but session is offline).';
    console.error(`⛔ Bulk job ${jobId}: ${reason}`);
    await failPendingItems(jobId, reason);
    activeJobsByClient.delete(sessionClientId);
    runningJobPromises.delete(jobId);
    return;
  }

  await MessageJob.findByIdAndUpdate(jobId, {
    status: 'running',
    startedAt: job.startedAt || new Date()
  });

  console.log(
    `🚀 Bulk job ${jobId} via ${sessionClientId} — fixed delay ${job.minDelay}ms, spread ${job.spreadHours}h`
  );

  try {
    console.log(`⏳ Bulk job ${jobId}: waiting for WhatsApp client to be fully ready...`);
    await waitForClientReady(sessionClientId);
    console.log(`✅ Bulk job ${jobId}: WhatsApp client ready, starting sends`);
  } catch (err) {
    console.error(`⛔ Bulk job ${jobId}: client not ready — ${err.message}`);
    await failPendingItems(jobId, err.message);
    activeJobsByClient.delete(sessionClientId);
    runningJobPromises.delete(jobId);
    return;
  }

  const sendOpts =
    job.mediaUrl && String(job.mediaUrl).trim()
      ? { mediaUrl: String(job.mediaUrl).trim() }
      : null;
  const logText = buildLogText(job.message, job.mediaUrl);

  while (true) {
    const freshJob = await MessageJob.findById(jobId);
    if (!freshJob || freshJob.status !== 'running') {
      console.log(`Bulk job ${jobId} is no longer running. Stopping.`);
      break;
    }

    if (!isClientConnected(sessionClientId)) {
      const reason = 'WhatsApp session went offline during bulk job.';
      await failPendingItems(jobId, reason);
      break;
    }

    const item = await MessageJobItem.findEarliestPending(jobId);
    if (!item) break;

    if (item.scheduledAt) {
      const waitMs = new Date(item.scheduledAt).getTime() - Date.now();
      if (waitMs > 500) {
        await waitForItemSchedule(item);
        continue;
      }
    }

    const userBalance = await User.getBalance(job.userId);
    if (userBalance <= 0) {
      console.log(`⛔ Bulk job ${jobId} stopped — insufficient message balance.`);
      const reason = 'Failed: insufficient message balance. You need to charge balance in message.';
      await failPendingItems(jobId, reason);
      emitToClient(sessionClientId, 'bulk-job-balance-exhausted', {
        jobId,
        message: 'You need to charge balance in message.'
      });
      sendBalanceExhaustedEmail({
        userId: job.userId,
        email: jobOwner?.email,
        name: jobOwner?.name
      })
        .then((result) => logBalanceEmailResult('bulk_job_blocked_zero', result, jobOwner?.email))
        .catch((err) => logBalanceEmailResult('bulk_job_blocked_zero', { ok: false, reason: err.message }, jobOwner?.email));
      break;
    }

    const phone = normalizePhone(item.phone);
    let success = false;
    let error = null;
    let whatsappId = null;

    try {
      const result = await sendMessage(sessionClientId, phone, job.message || '', sendOpts);
      whatsappId = result?.id?._serialized || null;
      success = true;
      console.log(`✅ Bulk job ${jobId}: sent to ${phone}`);
    } catch (err) {
      error = err.message;
      console.error(`❌ Bulk job ${jobId}: failed to send to ${phone}:`, err.message);
    }

    if (success) {
      await User.decrementBalance(job.userId, 1);
      const updatedBalance = await User.getBalance(job.userId);
      if (updatedBalance <= 0) {
        sendBalanceExhaustedEmail({
          userId: job.userId,
          email: jobOwner?.email,
          name: jobOwner?.name
        })
          .then((result) => logBalanceEmailResult('bulk_job_reached_zero', result, jobOwner?.email))
          .catch((err) => logBalanceEmailResult('bulk_job_reached_zero', { ok: false, reason: err.message }, jobOwner?.email));
      }
    }

    await MessageJobItem.findByIdAndUpdate(item._id, {
      status: success ? 'sent' : 'failed',
      sentAt: success ? new Date() : undefined,
      error: error || undefined,
      whatsappMessageId: whatsappId || undefined
    });

    await MessageLog.create({
      userId: logOwnerId,
      clientId: dbClient._id,
      phone: item.phone,
      message: logText,
      direction: 'outgoing',
      status: success ? 'sent' : 'failed',
      whatsappMessageId: whatsappId,
      error: error || undefined,
      source: logSource
    });

    const updateFields = success
      ? { $inc: { sentCount: 1 } }
      : { $inc: { failedCount: 1 } };
    const updated = await MessageJob.findByIdAndUpdate(jobId, updateFields, { new: true });

    emitToClient(sessionClientId, 'bulk-job-progress', {
      jobId,
      sentCount: updated.sentCount,
      failedCount: updated.failedCount,
      totalCount: updated.totalCount,
      pendingCount: updated.pendingCount,
      estimatedCompletedAt: updated.estimatedCompletedAt
    });
  }

  const finalJob = await MessageJob.findById(jobId);
  if (finalJob && finalJob.status === 'running') {
    const pending = await MessageJobItem.countDocuments({ jobId, status: 'pending' });
    let finalStatus = 'completed';
    if (pending > 0) finalStatus = 'failed';
    else if (finalJob.sentCount === 0 && finalJob.failedCount > 0) finalStatus = 'failed';
    await MessageJob.findByIdAndUpdate(jobId, {
      status: finalStatus,
      completedAt: new Date()
    });
    emitToClient(sessionClientId, 'bulk-job-completed', {
      jobId,
      status: finalStatus,
      sentCount: finalJob.sentCount,
      failedCount: finalJob.failedCount
    });
    console.log(`🎉 Bulk job ${jobId} ${finalStatus} (sent=${finalJob.sentCount}, failed=${finalJob.failedCount})`);
  }

  activeJobsByClient.delete(sessionClientId);
  runningJobPromises.delete(jobId);
};

const startMessageJob = async (jobId) => {
  const job = await MessageJob.findById(jobId);
  if (!job) throw new Error('Bulk job not found');

  if (runningJobPromises.has(jobId)) {
    throw new Error('Bulk job is already running');
  }

  const dbClient = await WhatsAppClientModel.findOne({ _id: job.clientId, isActive: true });
  if (!dbClient) throw new Error('WhatsApp client not found');

  if (activeJobsByClient.has(dbClient.clientId)) {
    throw new Error('This WhatsApp client is already sending messages');
  }

  activeJobsByClient.set(dbClient.clientId, jobId);

  const promise = processMessageJob(jobId).catch(async (err) => {
    console.error(`Bulk job ${jobId} error:`, err);
    await MessageJob.findByIdAndUpdate(jobId, { status: 'failed', completedAt: new Date() });
    activeJobsByClient.delete(dbClient.clientId);
    runningJobPromises.delete(jobId);
  });

  runningJobPromises.set(jobId, promise);
  return true;
};

const isClientSending = (sessionClientId) => activeJobsByClient.has(sessionClientId);

const resumeInterruptedJobs = async () => {
  const { query } = require('../db/mysql');
  const jobs = await query(
    `SELECT id FROM message_jobs WHERE status IN ('running', 'queued') ORDER BY created_at ASC`
  );
  if (!jobs.length) return;

  for (const row of jobs) {
    if (runningJobPromises.has(row.id)) continue;
    await MessageJob.findByIdAndUpdate(row.id, { status: 'queued' });
    try {
      await startMessageJob(row.id);
    } catch (err) {
      console.warn(`Could not resume bulk job ${row.id}:`, err.message);
    }
  }
};

module.exports = {
  startMessageJob,
  isClientSending,
  resumeInterruptedJobs
};
