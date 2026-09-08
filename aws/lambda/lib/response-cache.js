/**
 * A per-container mirror cache, standing in for the Cache API this platform
 * does not have.
 *
 * @description Same contract as the Cloudflare response cache, different store.
 *
 * WHY THIS EXISTS. The Cloudflare worker keeps mirror copies in
 * `caches.default`, so a repeat crawl of the same page is answered without
 * refetching from the receptionist. Lambda@Edge has no Cache API at all, so
 * that was dropped on CloudFront and every agent visit paid a full round trip.
 *
 * WHY IT IS NOT THE CDN CACHE, AND MUST NOT BECOME IT. A CloudFront hit is
 * answered BEFORE the origin-request function, so it would record no visit and
 * classify nothing. Every mirror is therefore `private, no-store` at the CDN
 * layer and stays that way. This cache sits INSIDE the function: the router
 * still runs, still classifies, still logs the visit, and only then answers
 * from memory instead of the network. Caching and telemetry are separable, and
 * this is the layer where they separate.
 *
 * The key folds SITE_ID + content_version + path, exactly like the Cloudflare
 * key, so it is tenant-unique and a publish self-invalidates by yielding a new
 * key rather than needing an eviction pass.
 *
 * Bounded on purpose. The router runs at 192 MB and has been measured using
 * ~118 MB, so the budget below is deliberately conservative; a single large
 * page must never be able to evict everything else, hence the per-entry cap.
 * Every operation swallows its own failure: a cache problem degrades to a
 * fetch, and can never fail a request.
 */

// One page's worth. Bigger mirrors are rare and are already handled by the
// origin-switch path, so holding them here would trade a lot of memory for
// very few hits.
const MAX_ENTRY_BYTES = 256 * 1024;

// Total container budget. Comfortably inside the measured headroom.
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const DEFAULT_TTL_SECONDS = 300;

/** key -> { body: Buffer, contentType: ?string, expiresAt: number } */
let store = new Map();
let totalBytes = 0;

/**
 * Drop everything. Test seam only.
 *
 * @returns {void}
 */
export function __resetResponseCache() {
  store = new Map();
  totalBytes = 0;
}

/**
 * Current entry count and byte total. Test seam only.
 *
 * @returns {{entries: number, bytes: number}} Cache occupancy.
 */
export function __responseCacheStats() {
  return { entries: store.size, bytes: totalBytes };
}

/**
 * The cache context for this request, or null to bypass the cache entirely.
 *
 * Mirrors `responseCacheContext` in the Cloudflare worker: NORG must have
 * enabled the cache for this site, published a content version, and the install
 * must know its own site id. Any of those missing means serve straight from the
 * receptionist, which is the behaviour this platform had before.
 *
 * @param {Object} env Install config.
 * @param {Object} feed Authenticated feed (responseCache, contentVersion).
 * @param {string} keySuffix Path suffix from pathToKeySuffix.
 * @returns {?{key: string, ttl: number}} Context, or null to bypass.
 */
export function cacheContext(env, feed, keySuffix) {
  const rc = feed && feed.responseCache;
  if (!rc || !rc.enabled) return null;
  const version = feed.contentVersion;
  if (!version || !env || !env.SITE_ID) return null;
  return {
    key: `${env.SITE_ID}/${version}${keySuffix}`,
    ttl: rc.ttl ?? DEFAULT_TTL_SECONDS,
  };
}

/**
 * Read a stored mirror, as a fresh Response the caller can consume.
 *
 * A new Response every time, because a body can only be read once and the same
 * entry may serve many requests from this container.
 *
 * @param {?{key: string}} ctx Context from cacheContext, or null.
 * @returns {?Response} The stored copy, or null on miss, expiry or any error.
 */
export function readCached(ctx) {
  if (!ctx) return null;
  try {
    const hit = store.get(ctx.key);
    if (!hit) return null;
    if (Date.now() >= hit.expiresAt) {
      store.delete(ctx.key);
      totalBytes -= hit.body.byteLength;
      return null;
    }
    // Re-insert so the eviction order is least-recently-USED, not merely oldest.
    store.delete(ctx.key);
    store.set(ctx.key, hit);
    const headers = hit.contentType ? { "content-type": hit.contentType } : undefined;
    return new Response(hit.body, { status: 200, headers });
  } catch (e) {
    console.error("norg mirror cache read failed", e);
    return null;
  }
}

/**
 * Store a mirror copy, best-effort.
 *
 * Never throws and never reports failure: a cache write that fails must not
 * turn a successful serve into an error.
 *
 * @param {?{key: string, ttl: number}} ctx Context from cacheContext, or null.
 * @param {Buffer} body The buffered mirror bytes.
 * @param {?string} contentType Content type to replay with the body.
 * @returns {void}
 */
export function writeCached(ctx, body, contentType) {
  if (!ctx || !body) return;
  try {
    if (body.byteLength > MAX_ENTRY_BYTES) return;
    const existing = store.get(ctx.key);
    if (existing) {
      store.delete(ctx.key);
      totalBytes -= existing.body.byteLength;
    }
    store.set(ctx.key, {
      body,
      contentType: contentType || null,
      expiresAt: Date.now() + ctx.ttl * 1000,
    });
    totalBytes += body.byteLength;
    // Evict least-recently-used until back inside the budget.
    for (const [key, entry] of store) {
      if (totalBytes <= MAX_TOTAL_BYTES) break;
      if (key === ctx.key) continue;
      store.delete(key);
      totalBytes -= entry.body.byteLength;
    }
  } catch (e) {
    console.error("norg mirror cache write failed", e);
  }
}
