const MessageJob = require('../models/MessageJob');
const MessageJobItem = require('../models/MessageJobItem');
const MessageLog = require('../models/MessageLog');
const WhatsAppClientModel = require('../models/WhatsAppClient');
const User = require('../models/User');
const { sendMessage } = require('./whatsappManager');
const { normalizePhone, sleep, randomDelay } = require('../utils/helpers');
const { emitToClient } = require('../utils/socket');
const { sendBalanceExhaustedEmail } = require('./balanceNotifier');

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

  await MessageJob.findByIdAndUpdate(jobId, {
    status: 'running',
    startedAt: job.startedAt || new Date()
  });

  console.log(`🚀 Starting bulk message job ${jobId} via client ${sessionClientId}`);

  const sendOpts =
    job.mediaUrl && String(job.mediaUrl).trim()
      ? { mediaUrl: String(job.mediaUrl).trim() }
      : null;
  const logText = buildLogText(job.message, job.mediaUrl);

  let hasMore = true;

  while (hasMore) {
    const freshJob = await MessageJob.findById(jobId);
    if (!freshJob || freshJob.status !== 'running') {
      console.log(`Bulk job ${jobId} is no longer running. Stopping.`);
      break;
    }

    const items = await MessageJobItem.find(
      { jobId, status: 'pending' },
      { limit: 10 }
    );

    if (items.length === 0) {
      hasMore = false;
      break;
    }

    for (const item of items) {
      const current = await MessageJob.findById(jobId);
      if (!current || current.status !== 'running') {
        console.log(`Bulk job ${jobId} stopped mid-send.`);
        return;
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
        return;
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
        userId: job.userId,
        clientId: dbClient._id,
        phone: item.phone,
        message: logText,
        direction: 'outgoing',
        status: success ? 'sent' : 'failed',
        whatsappMessageId: whatsappId,
        error: error || undefined
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
        pendingCount: updated.pendingCount
      });

      const morePending = await MessageJobItem.countDocuments({ jobId, status: 'pending' });
      if (morePending > 0) {
        const delay = randomDelay(
          job.minDelay || parseInt(process.env.MIN_DELAY_MS, 10) || 20000,
          job.maxDelay || parseInt(process.env.MAX_DELAY_MS, 10) || 30000
        );
        console.log(`⏳ Bulk job ${jobId}: waiting ${delay}ms before next message...`);
        await sleep(delay);
      }
    }
  }

  const finalJob = await MessageJob.findById(jobId);
  if (finalJob && finalJob.status === 'running') {
    const pending = await MessageJobItem.countDocuments({ jobId, status: 'pending' });
    const finalStatus = pending > 0 ? 'failed' : 'completed';
    await MessageJob.findByIdAndUpdate(jobId, {
      status: finalStatus,
      completedAt: new Date()
    });
    emitToClient(sessionClientId, 'bulk-job-completed', { jobId, status: finalStatus });
    console.log(`🎉 Bulk job ${jobId} ${finalStatus}`);
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
    `SELECT id FROM message_jobs WHERE status = 'running' ORDER BY created_at ASC`
  );
  if (!jobs.length) return;

  for (const row of jobs) {
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
