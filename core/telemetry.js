/**
 * Outbound control calls to NORG: visit events, render requests, heartbeats.
 *
 * @description Reports to NORG without ever delaying the visitor's response.
 *
 * Every call here is deferred (see deferred.js) rather than awaited, matching
 * the Cloudflare worker's use of `ctx.waitUntil`. Telemetry must never affect
 * what the visitor sees, so failures are swallowed and no caller inspects a
 * result.
 *
 * One deliberate behavioural difference from Cloudflare. The worker logs an
 * event for EVERY classified visit, including the plain origin passthrough that
 * humans take. On CloudFront the origin-request trigger only fires on a cache
 * MISS, so that event stream would be both incomplete and — since it rides the
 * customer's human traffic — the one place where a slow NORG could be felt by a
 * real visitor. Passthrough events are therefore off by default and enabled per
 * install with `x-norg-events-verbose`. Diverted traffic, which is what the
 * product measures, is always reported.
 */

import {
  CONTROL_CALL_TIMEOUT_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  RENDER_DEDUP_MAX_ENTRIES,
  RENDER_DEDUP_TTL_MS,
} from "./constants.mjs";
import { binding, controlHeaders, edgeEnv } from "./config.js";
import { edgeFetch } from "./http.js";
import { defer } from "./deferred.js";

// Served values that describe an untouched origin response. Reported only when
// the install opts into verbose events.
const PASSTHROUGH_SERVED = new Set(["origin", "origin_thin"]);

let lastHeartbeatAt = 0;
const renderDedup = new Map();

/**
 * POST to a NORG control endpoint, swallowing every failure.
 *
 * @param {Object} env Install config.
 * @param {string} path API path beginning with "/".
 * @param {Object} body JSON body.
 * @returns {Promise<?Response>} Response, or null on failure.
 */
async function postControl(env, path, body) {
  try {
    return await edgeFetch(env, `${binding(env, "NORG_API_URL")}${path}`, {
      method: "POST",
      headers: controlHeaders(env),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("norg edge control call failed", path, e);
    return null;
  }
}

/**
 * Geo and connection attributes CloudFront exposes as request headers.
 *
 * Cloudflare hands these over as `request.cf`; CloudFront adds them as
 * `CloudFront-Viewer-*` headers, but ONLY when the distribution's origin
 * request policy asks for them, so every field is independently optional and a
 * missing one must read as null rather than break the event.
 *
 * @param {Headers} headers Request headers.
 * @returns {Object} Event fields describing where the request came from.
 */
function viewerAttributes(headers) {
  const value = (name) => headers.get(name) || null;
  return {
    ip_country: value("cloudfront-viewer-country"),
    ip_city: value("cloudfront-viewer-city"),
    asn: value("cloudfront-viewer-asn"),
    // CloudFront publishes no AS organisation name and no edge-location id in
    // request headers; both are Cloudflare-only. Null keeps the event shape
    // identical across providers rather than inventing a value.
    as_organization: null,
    colo: null,
    http_protocol: value("cloudfront-viewer-http-version"),
    tls_version: value("cloudfront-viewer-tls"),
  };
}

/**
 * Report a classified visit to NORG.
 *
 * @param {Object} env Install config.
 * @param {Request} request Incoming request.
 * @param {Object} classification Bot classification.
 * @param {string} served How the request was answered.
 * @param {?number} rawWordCount Visible words in the raw origin, or null.
 * @param {?number} responseStatus Status actually returned, or null.
 * @returns {void}
 */
export function logEdgeEvent(
  env,
  request,
  classification,
  served,
  rawWordCount = null,
  responseStatus = null,
) {
  if (PASSTHROUGH_SERVED.has(served) && env.EDGE_EVENTS_VERBOSE !== "true") return;

  const url = new URL(request.url);
  defer(() =>
    postControl(env, "/api/v1/edge/events", {
      domain: url.hostname,
      path: url.pathname,
      user_agent: request.headers.get("user-agent") || null,
      is_ai_bot: classification.is_ai_bot,
      bot_name: classification.bot_name,
      company: classification.company,
      purpose: classification.purpose,
      served,
      raw_word_count: rawWordCount,
      response_status: responseStatus,
      ...viewerAttributes(request.headers),
    }),
  );
}

/**
 * Send a heartbeat if enough time has passed in this container.
 *
 * @param {Object} env Install config.
 * @param {string} trigger "traffic" or "cron".
 * @returns {void}
 */
export function maybeHeartbeat(env, trigger) {
  const now = Date.now();
  if (trigger === "traffic" && now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
  lastHeartbeatAt = now;

  defer(() =>
    postControl(env, "/api/v1/edge/heartbeat", {
      script_version: env.EDGE_SCRIPT_VERSION || "unknown",
      trigger,
      // The environment this install believes it is bound to. NORG warns when
      // this disagrees with the environment it can confirm, surfacing a
      // wrong-env manual install.
      env: edgeEnv(env),
      // Tells NORG which artifact is reporting, so drift detection compares
      // against that provider's version setting rather than the Cloudflare one.
      platform: env.EDGE_PLATFORM || "unknown",
    }),
  );
}

/**
 * Ask NORG to render a path, at most once per path per container window.
 *
 * Fired only when the receptionist returned a definite 404. A timeout or
 * network error is NOT a miss — reporting those would let an outage look like
 * every page vanishing, and NORG would re-render the whole site.
 *
 * @param {Object} env Install config.
 * @param {URL} url Requested URL.
 * @returns {void}
 */
export function requestRender(env, url) {
  const now = Date.now();
  const seenAt = renderDedup.get(url.pathname);
  if (seenAt && now - seenAt < RENDER_DEDUP_TTL_MS) return;

  // Bounded: drop the oldest entry rather than let a container grow forever.
  if (renderDedup.size >= RENDER_DEDUP_MAX_ENTRIES) {
    renderDedup.delete(renderDedup.keys().next().value);
  }
  renderDedup.set(url.pathname, now);

  defer(() =>
    postControl(env, "/api/v1/edge/render-requests", {
      path: url.pathname,
      url: url.toString(),
      reason: "bot_miss",
    }),
  );
}

/**
 * Reset per-container throttles. Test-only.
 *
 * @returns {void}
 */
export function __test_reset() {
  lastHeartbeatAt = 0;
  renderDedup.clear();
}
