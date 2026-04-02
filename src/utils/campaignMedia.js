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

module.exports = {
  sanitizeMediaUrl,
  pickRawMediaUrl,
  pickRawMediaType,
  bodyHasMediaUrlKey,
  resolveMediaUrlForDb,
  resolveMediaTypeForDb
};
