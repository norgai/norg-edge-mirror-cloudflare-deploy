/**
 * Install configuration, sourced from CloudFront custom origin headers.
 *
 * @description Replaces Cloudflare's worker bindings, which Lambda@Edge lacks.
 *
 * Lambda@Edge supports NO environment variables — that is an AWS restriction
 * with no workaround, and it is the reason this module exists. The install
 * instead attaches the same values Cloudflare passes as bindings to the
 * distribution's origin as custom headers, where an origin-request function can
 * read them from `request.origin.custom.customHeaders`.
 *
 * The headers are deleted from the request as soon as they are read. CloudFront
 * would otherwise forward them to the customer's own web server, putting
 * NORG_SITE_KEY — the one credential this install holds — into their access
 * logs. `readConfig` is the only correct way to obtain config for that reason:
 * it reads and redacts in one step, and nothing else should touch
 * customHeaders.
 *
 * The object it returns is deliberately shaped like the Cloudflare worker's
 * `env`, so every reader of it lives in core/config.js and is identical for
 * every provider.
 */

import { HEALTH_CHECK_HEADER } from "../../../core/constants.mjs";

/**
 * Version of this artifact, reported on every control call and heartbeat.
 *
 * Versioned independently of the Cloudflare worker because it is a separate
 * deployable with its own SHA-256 pin; content-craft compares it against
 * EDGE_WORKER_VERSION_CLOUDFRONT, not EDGE_WORKER_VERSION.
 *
 * 0.2.0 — carve-out cache behaviours and a 192 MB router. No request-handling
 * change; the version moves because the deployed artifact and the distribution
 * shape it expects both did.
 *
 * 0.3.0 — the distribution shape changes again, this time because a red-team
 * review found the agent cache bucket could be poisoned with origin bytes: a
 * new origin-response cache-guard function, MCP paths on their own behaviours
 * so the default one runs with IncludeBody off, dynamic carve-outs with no
 * cache, an EdgeDisabled kill switch, and opt-in rate limiting. The router
 * itself is unchanged; content-craft compares this against
 * EDGE_WORKER_VERSION_CLOUDFRONT.
 *
 * 0.5.0 — a per-container mirror cache (lib/response-cache.js), standing in
 * for the Cache API Lambda@Edge does not have. A repeat crawl of the same page
 * is answered from memory instead of refetching from the receptionist. It sits
 * INSIDE the function on purpose: the router still classifies and still records
 * the visit on a hit, which a CloudFront cache hit could not do. Mirrors stay
 * no-store at the CDN layer, unchanged.
 *
 * 0.4.0 — the site key stops travelling as an origin custom header. It now
 * lives in Secrets Manager and is fetched at the edge (lib/secret.js), so it is
 * no longer readable with cloudfront:GetDistributionConfig and rotation is one
 * place instead of two. Two leak paths are closed with it: the handler's
 * pre-redaction `pristine` clone, which forwarded the whole config header set
 * to the customer origin on any thrown exception or oversized response, and the
 * health-probe header, which carried the site key in a plain viewer request.
 *
 * 0.6.3 — the probe reads the site key before that fetch; 0.6.2 fetched
 * unauthenticated on this platform and still reported false.
 *
 * 0.6.2 — the keyed health probe fetches the feed before reporting
 * entitlement; a cold isolate answered entitled:false for a served site.
 *
 * 0.6.1 — the Host header is aligned to the origin on EVERY exit, including
 * the unconfigured early return and the catch: the origin-request policy
 * forwards the viewer's Host, and a virtual-hosted origin proxies an unknown
 * Host straight back into CloudFront (seen as a 403 on a whole site whose
 * distribution carried an empty x-norg-secret-arn). The site-key secret is
 * named under the stack (norg-edge-<site>-site-key) so a least-privilege
 * installer policy scoped to norg-edge-* covers it.
 *
 * 0.6.0 — two decisions, both simplifications. The human page is never cached
 * at the edge: the default behaviour uses CloudFront's managed CachingDisabled
 * policy, every page request reaches the router, and the viewer-request stamp,
 * the custom cache policy and the origin-response cache guard are gone with
 * the cache they protected. And the router makes no background call: an agent
 * visit is recorded by the receptionist from a header on the mirror fetch
 * (core/visit.js), a miss enqueues its render the same way, and the deferred
 * telemetry queue, its flush and sweep budgets, and the per-container mirror
 * cache are gone with it. Humans are answered before any lookup; the site key
 * is read from the replica in the region that ran the function. Behaviour
 * tracks edge-router-worker.js 0.11.7.
 */
export const EDGE_SCRIPT_VERSION = "0.6.3";

// Custom origin header -> binding name. Mirrors build_worker_bindings() in
// content-craft's install_service.py; adding a binding there means adding it
// here. Header names are lower-cased because CloudFront normalises them.
const CONFIG_HEADERS = {
  "x-norg-site-id": "SITE_ID",
  "x-norg-secret-arn": "NORG_SECRET_ARN",
  // Authorises the health probe and nothing else. Deliberately NOT the site
  // key: operators are told to send this over the wire, and the old header
  // compared against the key itself, which put a NORG credential into curl
  // history, proxy logs, and — on a failing probe — the customer's origin.
  "x-norg-probe-token": "PROBE_TOKEN",
  "x-norg-api-url": "NORG_API_URL",
  "x-norg-content-base": "NORG_CONTENT_BASE",
  "x-norg-strip-fallback": "STRIP_FALLBACK_ENABLED",
  "x-norg-disabled": "EDGE_DISABLED",
  "x-norg-lazy-render": "LAZY_RENDER_ENABLED",
  "x-norg-env": "EDGE_ENV",
  // CloudFront-only. Origin-request fires on a cache miss, so the passthrough
  // event stream is incomplete here and rides the customer's human traffic;
  // it is off unless an install explicitly asks for it. See telemetry.js.
  "x-norg-events-verbose": "EDGE_EVENTS_VERBOSE",
};

/**
 * Remove every NORG header from a request, so the origin can never see one.
 *
 * Two header sets, both of which have leaked in the past:
 *
 *  - the config custom headers, which CloudFront would otherwise forward to the
 *    customer's own web server and into their access logs;
 *  - the health-probe header, which a failing probe carried all the way to the
 *    origin.
 *
 * Deletion is unconditional — a header is removed whether or not it held a
 * value, so a half-configured install cannot leak through one we did not
 * recognise as populated. Safe to call more than once, and on any shape of
 * request, because it never throws.
 *
 * @param {Object} cfRequest CloudFront request, mutated in place.
 * @returns {Object} The same request, for chaining at a return site.
 */
export function scrubConfigHeaders(cfRequest) {
  const customHeaders = originCustomHeaders(cfRequest);
  if (customHeaders) {
    for (const header of Object.keys(CONFIG_HEADERS)) delete customHeaders[header];
  }
  if (cfRequest?.headers) delete cfRequest.headers[HEALTH_CHECK_HEADER];
  return cfRequest;
}

/**
 * The custom-header map of whichever origin type backs this request.
 *
 * CloudFront attaches origin custom headers to custom origins AND to S3
 * origins, under different keys in the event. Reading only `origin.custom`
 * meant an S3-backed distribution installed cleanly and then did nothing,
 * because the site id was never found.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @returns {?Object} The live header map, or null when the origin has none.
 */
export function originCustomHeaders(cfRequest) {
  const origin = cfRequest?.origin;
  return origin?.custom?.customHeaders || origin?.s3?.customHeaders || null;
}

/**
 * Read install config from the origin's custom headers, redacting as it goes.
 *
 * Reads and scrubs in one step; nothing else should touch customHeaders. Note
 * this is necessary but NOT sufficient — any object returned to CloudFront that
 * did not come through here must be passed through `scrubConfigHeaders` first.
 * The handler's failure paths return a clone taken before this ran.
 *
 * @param {Object} cfRequest CloudFront request, whose NORG headers are removed
 *   in place.
 * @returns {Object} Binding-shaped config object.
 */
export function readConfig(cfRequest) {
  const customHeaders = originCustomHeaders(cfRequest);
  // Captured before the scrub below removes it. The probe arrives as an
  // ordinary viewer request header, so it is read here rather than left on the
  // request: a FAILING probe used to carry it all the way to the origin.
  const probeHeader = cfRequest.headers?.[HEALTH_CHECK_HEADER]?.[0]?.value;
  // The version rides on the config object because core reads it there — each
  // provider's artifact is versioned and pinned separately by content-craft.
  const env = { EDGE_SCRIPT_VERSION, EDGE_PLATFORM: "cloudfront" };
  if (probeHeader !== undefined) env.PROBE_HEADER = probeHeader;
  if (!customHeaders) {
    scrubConfigHeaders(cfRequest);
    return env;
  }

  for (const [header, name] of Object.entries(CONFIG_HEADERS)) {
    const value = customHeaders[header]?.[0]?.value;
    if (value !== undefined) env[name] = value;
  }
  scrubConfigHeaders(cfRequest);
  return env;
}


export { CONFIG_HEADERS as __test_CONFIG_HEADERS };
