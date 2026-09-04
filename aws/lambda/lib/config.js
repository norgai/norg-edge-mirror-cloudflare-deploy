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

/**
 * Version of this artifact, reported on every control call and heartbeat.
 *
 * Versioned independently of the Cloudflare worker because it is a separate
 * deployable with its own SHA-256 pin; content-craft compares it against
 * EDGE_WORKER_VERSION_CLOUDFRONT, not EDGE_WORKER_VERSION. Behaviour tracks
 * edge-router-worker.js 0.11.6.
 *
 * 0.2.0 — carve-out cache behaviours and a 192 MB router. No request-handling
 * change; the version moves because the deployed artifact and the distribution
 * shape it expects both did.
 */
export const EDGE_SCRIPT_VERSION = "0.2.0";

// Custom origin header -> binding name. Mirrors build_worker_bindings() in
// content-craft's install_service.py; adding a binding there means adding it
// here. Header names are lower-cased because CloudFront normalises them.
const CONFIG_HEADERS = {
  "x-norg-site-id": "SITE_ID",
  "x-norg-site-key": "NORG_SITE_KEY",
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
 * Read install config from the origin's custom headers, redacting as it goes.
 *
 * @param {Object} cfRequest CloudFront request, whose customHeaders are emptied
 *   of NORG config in place.
 * @returns {Object} Binding-shaped config object.
 */
export function readConfig(cfRequest) {
  const customHeaders = cfRequest.origin?.custom?.customHeaders;
  // The version rides on the config object because core reads it there — each
  // provider's artifact is versioned and pinned separately by content-craft.
  const env = { EDGE_SCRIPT_VERSION, EDGE_PLATFORM: "cloudfront" };
  if (!customHeaders) return env;

  for (const [header, name] of Object.entries(CONFIG_HEADERS)) {
    const value = customHeaders[header]?.[0]?.value;
    if (value !== undefined) env[name] = value;
    // Deleted whether or not it was set, so a half-configured install cannot
    // leak a key through a header we did not recognise as populated.
    delete customHeaders[header];
  }
  return env;
}


export { CONFIG_HEADERS as __test_CONFIG_HEADERS };
