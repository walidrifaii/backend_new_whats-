const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DEFAULT_SPREAD_HOURS = Math.max(0.1, parseFloat(process.env.BULK_SPREAD_HOURS) || 16);
const MAX_BULK_PHONES = Math.max(2, parseInt(process.env.MAX_BULK_PHONES, 10) || 500);
const MIN_DELAY_FLOOR_MS = Math.max(1000, parseInt(process.env.BULK_MIN_DELAY_MS, 10) || 3000);

const formatDuration = (totalMs) => {
  if (totalMs <= 0) return 'Less than 1 minute';

  const totalMinutes = Math.ceil(totalMs / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [`${hours} hour${hours === 1 ? '' : 's'}`];
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days > 0) {
    const dayParts = [`${days} day${days === 1 ? '' : 's'}`];
    if (remHours > 0) dayParts.push(`${remHours} hour${remHours === 1 ? '' : 's'}`);
    return dayParts.join(' ');
  }

  return parts.join(' ');
};

/**
 * Fixed delay between every message, sized so MAX_BULK_PHONES finish in spreadHours.
 * - 500 messages → ~16 hours total
 * - 10 messages  → same gap, much shorter total (~17 min for 16h/500 config)
 * minDelay === maxDelay (no random jitter).
 */
const calculateBulkSchedule = (phoneCount, spreadHours = DEFAULT_SPREAD_HOURS) => {
  const count = Math.max(1, parseInt(phoneCount, 10) || 1);
  const spread = Math.max(0.1, parseFloat(spreadHours) || DEFAULT_SPREAD_HOURS);
  const maxPhones = MAX_BULK_PHONES;

  if (count === 1) {
    return {
      phoneCount: count,
      maxPhones,
      spreadHours: spread,
      maxSpreadHours: spread,
      delayBetweenMessagesMs: 0,
      delayBetweenMessagesSeconds: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
      estimatedTotalMs: 0,
      estimatedHours: 0,
      estimatedDays: 0,
      estimatedDuration: 'Less than 1 minute',
      messagesPerHour: count,
      spreadTargetMet: true
    };
  }

  const maxTotalMs = spread * MS_PER_HOUR;
  let delayMs = Math.floor(maxTotalMs / (maxPhones - 1));
  let spreadTargetMet = true;

  if (delayMs < MIN_DELAY_FLOOR_MS) {
    delayMs = MIN_DELAY_FLOOR_MS;
    spreadTargetMet = false;
  }

  const estimatedTotalMs = delayMs * (count - 1);
  const estimatedHours = +(estimatedTotalMs / MS_PER_HOUR).toFixed(2);
  const estimatedDays = +(estimatedTotalMs / MS_PER_DAY).toFixed(2);
  const maxTotalHours = +(maxTotalMs / MS_PER_HOUR).toFixed(2);

  return {
    phoneCount: count,
    maxPhones,
    spreadHours: spread,
    maxSpreadHours: spread,
    delayBetweenMessagesMs: delayMs,
    delayBetweenMessagesSeconds: Math.round(delayMs / 1000),
    minDelayMs: delayMs,
    maxDelayMs: delayMs,
    estimatedTotalMs,
    estimatedHours,
    estimatedDays,
    estimatedDuration: formatDuration(estimatedTotalMs),
    maxTotalHoursAtMaxPhones: maxTotalHours,
    maxTotalDurationAtMaxPhones: formatDuration(maxTotalMs),
    messagesPerHour: estimatedHours > 0 ? +(count / estimatedHours).toFixed(1) : count,
    spreadTargetMet,
    note:
      `${maxPhones} messages use up to ${spread} hour(s). ` +
      `${count} message(s) finish in ${formatDuration(estimatedTotalMs)} with the same fixed gap.`,
    ...(spreadTargetMet
      ? {}
      : {
          warning: `Minimum delay floor (${MIN_DELAY_FLOOR_MS}ms) applied; ${maxPhones} messages would exceed ${spread} hour(s).`
        })
  };
};

const buildItemSchedule = (phoneList, delayMs, startAt = new Date()) => {
  const base = startAt instanceof Date ? startAt.getTime() : Date.now();
  return phoneList.map((phone, index) => ({
    phone,
    scheduledAt: new Date(base + index * delayMs)
  }));
};

const estimateCompletionAt = (phoneCount, delayMs, startAt = new Date()) => {
  const count = Math.max(1, parseInt(phoneCount, 10) || 1);
  if (count <= 1) return new Date(startAt);
  const base = startAt instanceof Date ? startAt.getTime() : Date.now();
  return new Date(base + delayMs * (count - 1));
};

module.exports = {
  DEFAULT_SPREAD_HOURS,
  MAX_BULK_PHONES,
  MIN_DELAY_FLOOR_MS,
  calculateBulkSchedule,
  buildItemSchedule,
  estimateCompletionAt,
  formatDuration
};
