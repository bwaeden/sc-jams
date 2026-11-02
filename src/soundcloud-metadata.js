import { normalizeTrackUrl } from './rooms.js';

const DAY = 24 * 60 * 60 * 1000;

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
}

function publicTrackUrl(value) {
  try {
    const url = normalizeTrackUrl(value);
    return new URL(url).hostname === 'soundcloud.com' ? url : null;
  } catch { return null; }
}

function artworkUrl(value) {
  if (typeof value !== 'string' || value.length >= 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'sndcdn.com' || url.hostname.endsWith('.sndcdn.com'))) return url.href;
  } catch { /* Artwork is optional. */ }
  return null;
}

function readMetadata(data, source) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data.provider_name && data.provider_name !== 'SoundCloud')) return null;
  const author = text(data.author_name, 100);
  let title = text(data.title, 400);
  const suffix = author && ` by ${author}`;
  if (suffix && title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
  title = title.slice(0, 200);
  if (!title) return null;
  const result = { title, artist: author || 'SoundCloud' };
  const artwork = artworkUrl(data.thumbnail_url);
  if (artwork) result.artwork = artwork;
  const sourceUrl = new URL(source);
  if (sourceUrl.hostname === 'api.soundcloud.com') result.soundcloudId = sourceUrl.pathname.split('/').at(-1);
  else result.permalinkUrl = source;
  if (!result.permalinkUrl && typeof data.html === 'string') {
    // Only read public track links; never render or execute provider HTML.
    for (const match of data.html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
      const href = (match[1] || match[2]).replace(/&(?:amp|#38|#x26);/gi, '&');
      const permalink = publicTrackUrl(href);
      if (permalink) { result.permalinkUrl = permalink; break; }
    }
  }
  return result;
}

function duration(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Read public oEmbed metadata without loading or fetching any audio. */
export function createSoundCloudMetadataResolver({
  fetch: fetchImpl = globalThis.fetch,
  concurrency = 3,
  cacheMs = DAY,
  failureCacheMs = 60_000,
  maxCacheEntries = 1000,
  requestTimeoutMs = 8000,
  now = Date.now,
} = {}) {
  const limit = Math.max(1, duration(concurrency, 3));
  const successTtl = duration(cacheMs, DAY);
  const failureTtl = duration(failureCacheMs, 60_000);
  const capacity = duration(maxCacheEntries, 1000);
  const timeout = Math.max(1, duration(requestTimeoutMs, 8000));
  const cache = new Map(), pending = new Map(), queue = [];
  let active = 0, blockedUntil = 0;
  const copy = (value) => value ? { ...value } : null;

  function remember(url, value) {
    if (!capacity) return;
    cache.delete(url);
    cache.set(url, { value: copy(value), expiresAt: now() + (value ? successTtl : failureTtl) });
    while (cache.size > capacity) cache.delete(cache.keys().next().value);
  }

  async function fetchMetadata(url) {
    if (now() < blockedUntil) return null;
    try {
      const endpoint = new URL('https://soundcloud.com/oembed');
      endpoint.searchParams.set('format', 'json');
      endpoint.searchParams.set('url', url);
      const response = await fetchImpl(endpoint.href, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
      if (response.status === 429) {
        const retryAfter = response.headers?.get('retry-after');
        const seconds = Number(retryAfter);
        const retryMs = retryAfter && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter || '') - now();
        blockedUntil = now() + Math.max(1, Math.min(DAY, Number.isFinite(retryMs) && retryMs > 0 ? retryMs : failureTtl));
        return null;
      }
      if (!response.ok) return null;
      return readMetadata(await response.json(), url);
    } catch { return null; }
  }

  async function run(task) {
    let value = null;
    try { value = await fetchMetadata(task.url); } catch { /* Failed lookups must not affect playback. */ }
    remember(task.url, value);
    pending.delete(task.url);
    task.resolve(value);
    active--;
    pump();
  }

  function pump() {
    while (queue.length && active < limit) {
      active++;
      void run(queue.shift());
    }
  }

  return async function resolveMetadata(value) {
    let url;
    try { url = normalizeTrackUrl(value); } catch { return null; }
    const cached = cache.get(url);
    if (cached && now() < cached.expiresAt) {
      cache.delete(url);
      cache.set(url, cached);
      return copy(cached.value);
    }
    if (cached) cache.delete(url);
    if (pending.has(url)) return copy(await pending.get(url));
    let complete;
    const promise = new Promise((resolve) => { complete = resolve; });
    pending.set(url, promise);
    queue.push({ url, resolve: complete });
    pump();
    return copy(await promise);
  };
}
