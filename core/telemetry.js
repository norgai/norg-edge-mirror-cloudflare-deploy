/**
 * Outbound control calls to NORG that are not on any visitor's path.
 *
 * @description The opt-in passthrough event, sent off the response path.
 *
 * Agent visits are not reported from here: every adapter records those by
 * describing the visit in a header on the mirror fetch it awaits anyway
 * (core/visit.js), and the receptionist writes the event through its own
 * deferred-work primitive. What remains is the human passthrough event, off
 * by default, which must never hold a person's response. It is started at
 * once and handed to the platform's keep-alive when the adapter provides one
 * (`env.EDGE_KEEPALIVE`, Fastly and Bunny); where none exists (Lambda@Edge) it
 * is left un-awaited, and a freezing container may drop it. That is the
 * accepted cost of never making a human wait.
 */

import { DEFERRED_CALL_TIMEOUT_MS } from "./constants.mjs";
import { binding, controlHeaders } from "./config.js";
import { edgeFetch, timeoutSignal } from "./http.js";
import { viewerAttributes } from "./visit.js";

// Served values that describe an untouched origin response. Reported only when
// the install opts into verbose events.
const PASSTHROUGH_SERVED = new Set(["origin", "origin_thin"]);

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
    const response = await edgeFetch(env, `${binding(env, "NORG_API_URL")}${path}`, {
      method: "POST",
      headers: controlHeaders(env),
      body: JSON.stringify(body),
      signal: timeoutSignal(DEFERRED_CALL_TIMEOUT_MS),
    });
    // A refused call used to be indistinguishable from a delivered one: only a
    // thrown error was logged, so a 401 or a 422 left no trace anywhere. That
    // is how a whole provider can look healthy while recording nothing.
    if (!response.ok) {
      console.error("norg edge control call refused", path, response.status);
    }
    return response;
  } catch (e) {
    console.error("norg edge control call failed", path, e);
    return null;
  }
}

/**
 * The event document NORG's /edge/events endpoint stores.
 *
 * @param {Request} request Incoming request.
 * @param {Object} classification Bot classification.
 * @param {string} served How the request was answered.
 * @returns {Object} JSON body.
 */
function eventBody(request, classification, served) {
  const url = new URL(request.url);
  return {
    domain: url.hostname,
    path: url.pathname,
    user_agent: request.headers.get("user-agent") || null,
    is_ai_bot: classification.is_ai_bot,
    bot_name: classification.bot_name,
    company: classification.company,
    purpose: classification.purpose,
    served,
    raw_word_count: null,
    response_status: null,
    ...viewerAttributes(request.headers),
  };
}

/**
 * Report a visit with a call that is started now and never waited for here.
 *
 * @param {Object} env Install config.
 * @param {Request} request Incoming request.
 * @param {Object} classification Bot classification.
 * @param {string} served How the request was answered.
 * @returns {Promise<void>} Settles with the call; never rejects.
 */
export function fireEdgeEvent(env, request, classification, served) {
  if (PASSTHROUGH_SERVED.has(served) && env.EDGE_EVENTS_VERBOSE !== "true") {
    return Promise.resolve();
  }
  return postControl(env, "/api/v1/edge/events", eventBody(request, classification, served))
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Report a human passthrough, entirely off the visitor's path.
 *
 * Opt-in (`EDGE_EVENTS_VERBOSE`). The call is handed to the platform's
 * keep-alive where the adapter provides one, so on Fastly and Bunny it lands
 * after the response; elsewhere it is best-effort.
 *
 * @param {Object} env Install config.
 * @param {Request} request Incoming request.
 * @param {Object} classification Classification to report, human by default.
 * @returns {void}
 */
export function reportPassthrough(env, request, classification) {
  if (env.EDGE_EVENTS_VERBOSE !== "true") return;
  const done = fireEdgeEvent(env, request, classification, "origin");
  if (typeof env.EDGE_KEEPALIVE === "function") env.EDGE_KEEPALIVE(done);
}
