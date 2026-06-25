/**
 * Normalize campaign media URL from API body (camelCase + snake_case aliases).
 */
function pickRawMediaUrl(body = {}) {
  if (!body || typeof body !== 'object') return undefined;
  const v =
    body.mediaUrl ??
    body.media_url ??
    body.imageUrl ??
    body.image_url;
  return v;
}

function pickRawMediaType(body = {}) {
  if (!body || typeof body !== 'object') return undefined;
  return body.mediaType ?? body.media_type ?? body.imageType;
}

function bodyHasMediaUrlKey(body = {}) {
  return ['mediaUrl', 'media_url', 'imageUrl', 'image_url'].some((k) => k in body);
}

function bodyHasMediaTypeKey(body = {}) {
  return ['mediaType', 'media_type', 'imageType'].some((k) => k in body);
}

/**
 * Fix values like https://cdn.example/https://cdn.example/path/file.webp
 */
function sanitizeMediaUrl(url) {
  if (url === undefined || url === null) return null;
  if (typeof url !== 'string') return null;
  let t = url.trim();
  if (!t) return null;
  let prev;
  do {
    prev = t;
    const m = t.match(/^(https?:\/\/[^/]+)\/((?:https?:\/\/).+)$/i);
    if (m) t = m[2].trim();
  } while (t !== prev);
  return t;
}

function resolveMediaUrlForDb(body) {
  if (!bodyHasMediaUrlKey(body)) return { set: false };
  const raw = pickRawMediaUrl(body);
  if (raw === undefined || raw === null) return { set: true, value: null };
  const s = typeof raw === 'string' ? raw : String(raw);
  if (!s.trim()) return { set: true, value: null };
  return { set: true, value: sanitizeMediaUrl(s) };
}

function resolveMediaTypeForDb(body) {
  if (!bodyHasMediaTypeKey(body)) return { set: false };
  const raw = pickRawMediaType(body);
  if (raw === undefined || raw === null) return { set: true, value: null };
  const s = typeof raw === 'string' ? raw : String(raw);
  if (!s.trim()) return { set: true, value: null };
  return { set: true, value: s.trim() };
}

/** Detect example/placeholder URLs that will always fail at send time. */
function isPlaceholderMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /(?:^|\/\/)(?:[^/]*\.)?(?:example\.com|yoursite\.com)(?:\/|$)/i.test(url.trim());
}

/**
 * Verify the server can download the media URL (same requirement as WhatsApp send).
 */
async function validateMediaUrlReachable(url, { timeoutMs = 12000 } = {}) {
  if (!url) return { ok: true };
  if (isPlaceholderMediaUrl(url)) {
    return {
      ok: false,
      reason: 'mediaUrl looks like a placeholder (example.com / yoursite.com). Use a real public image URL or remove mediaUrl.'
    };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, reason: 'mediaUrl must start with http:// or https://' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Range: 'bytes=0-1023' }
    });
    if (!res.ok && res.status !== 206) {
      return { ok: false, reason: `Media URL returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timed out' : err.message;
    return { ok: false, reason: `Media URL not reachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sanitizeMediaUrl,
  pickRawMediaUrl,
  pickRawMediaType,
  bodyHasMediaUrlKey,
  resolveMediaUrlForDb,
  resolveMediaTypeForDb,
  isPlaceholderMediaUrl,
  validateMediaUrlReachable
};
