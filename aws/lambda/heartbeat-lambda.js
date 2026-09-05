/**
 * NORG edge router — scheduled heartbeat (regional Lambda, us-east-1).
 *
 * @description Replaces the Cloudflare cron trigger for a CloudFront install.
 *
 * The Cloudflare worker declares `triggers.crons: ["*​/30 * * * *"]` and answers
 * a `scheduled()` event. Lambda@Edge has no scheduled trigger of any kind, so
 * that liveness beat has to come from somewhere else — an ordinary Lambda in
 * the customer's account, driven by EventBridge Scheduler on the same 30-minute
 * cadence.
 *
 * Why it matters enough to be its own function: the cron beat is what proves a
 * zero-traffic install is alive at all. The traffic beat only fires once an
 * agent has actually been served, so without this a freshly-installed site with
 * no crawler visits looks identical to one that was never deployed.
 *
 * What it can and cannot prove is worth being precise about. It proves the
 * install's configuration is present and NORG accepts its credentials. It does
 * NOT prove the router is associated with a distribution, or that any traffic
 * reaches it — only a `trigger: "traffic"` beat from the edge function shows
 * that. NORG distinguishes the two.
 *
 * Unlike the router, this is not an edge function, so it MAY use environment
 * variables — which is the whole reason the site key can live in configuration
 * here rather than being threaded through a request.
 */

import { CONTROL_CALL_TIMEOUT_MS } from "../../core/constants.mjs";
import { EDGE_SCRIPT_VERSION } from "./lib/config.js";

/**
 * Send one heartbeat to NORG.
 *
 * Throws on a refusal so the scheduled invocation is recorded as failed and
 * surfaces in the customer's own CloudWatch metrics — a silently failing
 * heartbeat would look exactly like a healthy quiet site.
 *
 * @returns {Promise<Object>} NORG's heartbeat response body.
 */
export async function handler() {
  const {
    SITE_ID,
    NORG_SITE_KEY,
    NORG_API_URL = "https://content-craft-api.norg.ai",
    EDGE_ENV = "unknown",
  } = process.env;

  if (!SITE_ID || !NORG_SITE_KEY) {
    throw new Error("norg edge heartbeat: SITE_ID and NORG_SITE_KEY are required");
  }

  const response = await fetch(`${NORG_API_URL}/api/v1/edge/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Norg-Site-Id": SITE_ID,
      "X-Norg-Site-Key": NORG_SITE_KEY,
      "X-Norg-Edge-Version": EDGE_SCRIPT_VERSION,
    },
    body: JSON.stringify({
      script_version: EDGE_SCRIPT_VERSION,
      trigger: "cron",
      env: EDGE_ENV,
      platform: "cloudfront",
    }),
    signal: AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`norg edge heartbeat rejected: HTTP ${response.status}`);
  }
  return response.json();
}

export default handler;
