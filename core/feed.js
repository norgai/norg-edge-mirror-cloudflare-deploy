/**
 * The authenticated bot-pattern feed, and the entitlement it carries.
 *
 * @description Obtains and caches NORG's feed; nothing diverts without it.
 *
 * Rule 3 of the worker contract lives here: which crawlers exist, which may be
 * diverted and which source IPs are genuinely theirs are all NORG's to publish
 * and to withdraw, and there is deliberately NO hardcoded fallback pattern set.
 * Until one authenticated call succeeds, the router changes nothing at all.
 *
 * The Cloudflare worker caches this at two levels — in-isolate, then in the
 * colo's Cache API. Lambda@Edge has no programmatic cache, so only the
 * in-container level survives. Two things compensate:
 *
 *  1. A conditional request (`If-None-Match`). Lambda containers are more
 *     numerous and shorter-lived than Workers isolates, so the feed would
 *     otherwise be refetched far more often; a 304 costs NORG almost nothing
 *     and refreshes the entry without re-parsing it.
 *  2. The stale-while-revalidate path defers its refresh (see deferred.js)
 *     rather than dropping it, so a stale-but-entitled install still answers
 *     immediately and neither a slow NORG nor a NORG outage adds latency.
 *
 * The distinction the whole module is built around: a REFUSAL (401/403) is NORG
 * saying this install may not serve and is obeyed at once; a timeout or network
 * error says nothing about entitlement and must never revoke a working install.
 */

import {
  PATTERN_DEFAULT_TTL_MS,
  REFUSAL_STATUSES,
  RESPONSE_CACHE_DEFAULT_TTL_SECONDS,
  DEFAULT_AGENTIC_PATH_PREFIX,
  PATTERN_FETCH_TIMEOUT_MS,
  UNENTITLED,
  UNENTITLED_TTL_MS,
} from "./constants.mjs";
import { binding, controlHeaders } from "./config.js";
import { edgeFetch, timeoutSignal } from "./http.js";
import { defer } from "./deferred.js";

// The authenticated feed for this container. Starts unentitled: nothing is
// served differently until NORG has confirmed this install at least once.
let feedCache = {
  entitled: false,
  patterns: [],
  cidrRanges: {},
  skipPaths: [],
  fetchedAt: 0,
  ttl: PATTERN_DEFAULT_TTL_MS,
};

/**
 * Parse a feed response body into a verdict entry.
 *
 * @param {Response} response Feed response from NORG.
 * @returns {Promise<?Object>} Verdict entry, or null when unusable.
 */
export async function readFeedBody(response) {
  try {
    const data = await response.json();
    const rc = data.response_cache || {};
    return {
      entitled: true,
      patterns: data.patterns || [],
      cidrRanges: data.cidr_ranges || {},
      agenticPathPrefix: data.agentic_path_prefix || DEFAULT_AGENTIC_PATH_PREFIX,
      // Per-route mirror skip: paths an operator marked to pass through to
      // origin. An array of normalised EdgeRoute paths.
      skipPaths: Array.isArray(data.skip_paths) ? data.skip_paths : [],
      contentVersion: data.content_version || "",
      responseCache: {
        enabled: rc.enabled === true,
        // Nullish (not falsy) fallback: an operator-set ttl of 0 is a valid
        // "immediate expiry" request; only a missing/null ttl takes the default.
        ttl: rc.ttl ?? RESPONSE_CACHE_DEFAULT_TTL_SECONDS,
      },
      // Kept so the next refresh can be conditional.
      etag: response.headers.get("etag") || "",
      fetchedAt: Date.now(),
      ttl: (data.cache_ttl ? data.cache_ttl : 3600) * 1000,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Build a fresh negative (unentitled) verdict stamped with the current time.
 *
 * @returns {Object} UNENTITLED plus fetchedAt and the short negative-cache TTL.
 */
function negativeVerdict() {
  return { ...UNENTITLED, fetchedAt: Date.now(), ttl: UNENTITLED_TTL_MS };
}

/**
 * Record the unentitled verdict for UNENTITLED_TTL_MS.
 *
 * Overwrites any entitled entry, so a refused install stops diverting at once.
 *
 * @returns {void}
 */
function stampNegativeFeed() {
  feedCache = negativeVerdict();
}

/**
 * Refresh the authenticated feed from NORG.
 *
 * @param {Object} env Install config.
 * @returns {Promise<{outcome: string, entry: ?Object}>} outcome is
 *   "ok" | "refused" | "unreachable".
 */
export async function refreshFeed(env) {
  const previous = feedCache;
  let response;
  try {
    const headers = controlHeaders(env);
    // Only conditional when there is something to revalidate; a 304 against an
    // entry we no longer hold would leave us with nothing to serve.
    if (previous.entitled && previous.etag) headers["If-None-Match"] = previous.etag;

    response = await edgeFetch(env, `${binding(env, "NORG_API_URL")}/api/v1/edge/bot-patterns`, {
      method: "GET",
      headers,
      signal: timeoutSignal(PATTERN_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("norg edge feed refresh failed", e);
    return { outcome: "unreachable", entry: null };
  }

  if (REFUSAL_STATUSES.has(response.status)) {
    stampNegativeFeed();
    return { outcome: "refused", entry: null };
  }

  // Unchanged: keep the entry we already hold and restart its TTL.
  if (response.status === 304 && previous.entitled) {
    feedCache = { ...previous, fetchedAt: Date.now() };
    return { outcome: "ok", entry: feedCache };
  }

  if (!response.ok) return { outcome: "unreachable", entry: null };

  const entry = await readFeedBody(response);
  if (!entry) return { outcome: "unreachable", entry: null };
  feedCache = entry;
  return { outcome: "ok", entry };
}

/**
 * Get the authenticated feed, preferring speed over freshness.
 *
 * A stale-but-entitled entry is served immediately with the refresh deferred,
 * so neither a slow NORG nor a NORG outage adds latency or withdraws a working
 * install. A fresh negative verdict short-circuits with no network call; a
 * STALE negative one deliberately does not, so re-entitlement lands within a
 * minute of NORG allowing it again.
 *
 * @param {Object} env Install config.
 * @returns {Promise<Object>} Feed with entitled, patterns and cidrRanges.
 */
export async function getBotFeed(env) {
  const now = Date.now();
  if (feedCache.fetchedAt && now - feedCache.fetchedAt < feedCache.ttl) return feedCache;

  if (feedCache.entitled) {
    defer(() => refreshFeed(env));
    return feedCache;
  }

  const { outcome, entry } = await refreshFeed(env);
  if (outcome === "ok") return entry;
  // A refusal already stamped the negative verdict inside refreshFeed; an
  // unreachable probe with nothing usable cached stamps it here so the next
  // request skips the blocking fetch for the window.
  if (outcome === "unreachable") stampNegativeFeed();
  return feedCache;
}

/**
 * Does this container currently hold an authenticated feed?
 *
 * Reported by the health probe: an unentitled router passes everything through
 * and is otherwise indistinguishable from not being installed at all, so this
 * is the first question to ask about an install that is "doing nothing".
 *
 * @returns {boolean} True when NORG has authenticated this install.
 */
export function isEntitled() {
  return feedCache.entitled;
}

/**
 * Reset feed state. Test-only.
 *
 * @param {?Object} entry Entry to seed, or null for a cold container.
 * @returns {void}
 */
export function __test_setFeed(entry) {
  feedCache = entry || {
    entitled: false,
    patterns: [],
    cidrRanges: {},
    skipPaths: [],
    fetchedAt: 0,
    ttl: PATTERN_DEFAULT_TTL_MS,
  };
}

/**
 * Read feed state. Test-only.
 *
 * @returns {Object} The current cached verdict.
 */
export function __test_getFeed() {
  return feedCache;
}
