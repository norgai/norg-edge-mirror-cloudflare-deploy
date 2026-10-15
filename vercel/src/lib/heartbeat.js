/**
 * The liveness beat: how NORG learns this install runs, and on which version.
 *
 * @description Throttled heartbeat, sent after the response via waitUntil.
 *
 * Vercel has no scheduled trigger inside middleware, and NORG cannot reach a
 * Vercel project to ask. So the beat rides on requests that already left the
 * human fast path: once after an agent is served ("traffic" — proof that the
 * middleware runs on the customer's real route) and once after an
 * authenticated health probe ("probe" — proof it is deployed). At most one
 * beat per instance per HEARTBEAT_MIN_INTERVAL_MS, and always after the
 * response through the platform's waitUntil, so no visitor waits for it.
 */

import { CONTROL_CALL_TIMEOUT_MS, HEARTBEAT_MIN_INTERVAL_MS } from "../../../core/constants.mjs";
import { binding, controlHeaders, edgeEnv } from "../../../core/config.js";
import { edgeFetch, timeoutSignal } from "../../../core/http.js";

let lastBeatAt = 0;

/**
 * Send a heartbeat if this instance has not sent one recently.
 *
 * @param {Object} env Install config (carries EDGE_KEEPALIVE when available).
 * @param {string} trigger "traffic" | "probe".
 * @param {?string} colo Answering edge region.
 * @returns {void}
 */
export function maybeHeartbeat(env, trigger, colo) {
  const now = Date.now();
  if (now - lastBeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
  lastBeatAt = now;
  const done = sendHeartbeat(env, trigger, colo);
  if (typeof env.EDGE_KEEPALIVE === "function") env.EDGE_KEEPALIVE(done);
}

/**
 * POST the beat, swallowing every failure.
 *
 * @param {Object} env Install config.
 * @param {string} trigger Beat trigger.
 * @param {?string} colo Answering edge region.
 * @returns {Promise<void>} Settles when the call does; never rejects.
 */
async function sendHeartbeat(env, trigger, colo) {
  try {
    const response = await edgeFetch(env, `${binding(env, "NORG_API_URL")}/api/v1/edge/heartbeat`, {
      method: "POST",
      headers: controlHeaders(env),
      body: JSON.stringify({
        script_version: env.EDGE_SCRIPT_VERSION,
        trigger,
        colo: colo || null,
        env: edgeEnv(env),
        platform: env.EDGE_PLATFORM,
      }),
      signal: timeoutSignal(CONTROL_CALL_TIMEOUT_MS),
    });
    if (!response.ok) console.error("norg edge heartbeat refused", response.status);
  } catch (e) {
    console.error("norg edge heartbeat failed", e);
  }
}

/**
 * Forget the last beat (tests only).
 *
 * @returns {void}
 */
export function __test_resetHeartbeat() {
  lastBeatAt = 0;
}
