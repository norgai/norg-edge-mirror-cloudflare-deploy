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
 * `env`, so `binding()`, `controlHeaders()` and `contentStem()` below are the
 * same functions as their counterparts there.
 */

import { BINDING_DEFAULTS } from "./constants.mjs";

/**
 * Version of this artifact, reported on every control call and heartbeat.
 *
 * Versioned independently of the Cloudflare worker because it is a separate
 * deployable with its own SHA-256 pin; content-craft compares it against
 * EDGE_WORKER_VERSION_CLOUDFRONT, not EDGE_WORKER_VERSION. Behaviour tracks
 * edge-router-worker.js 0.11.6.
 */
export const EDGE_SCRIPT_VERSION = "0.1.0";

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
  const env = {};
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

/**
 * Resolve a binding, falling back to its baked default.
 *
 * Only an ABSENT binding takes the default; an explicitly-set value is returned
 * unchanged. Identical to `binding()` in the Cloudflare worker.
 *
 * @param {Object} env Config object from readConfig.
 * @param {string} name Binding name present in BINDING_DEFAULTS.
 * @returns {string} The configured value, or the baked default.
 */
export function binding(env, name) {
  const value = env[name];
  return value === undefined ? BINDING_DEFAULTS[name] : value;
}

/**
 * NORG environment this install is bound to.
 *
 * A test-bound install serves TEST content, so it must be identifiable from
 * outside and must never look like a prod install; "unknown" is the fallback.
 *
 * @param {Object} env Config object.
 * @returns {string} "production" | "test" | "unknown".
 */
export function edgeEnv(env) {
  return env.EDGE_ENV || "unknown";
}

/**
 * Headers authenticating this install to the NORG control endpoints.
 *
 * @param {Object} env Config object.
 * @returns {Object} Header map for a control call.
 */
export function controlHeaders(env) {
  return {
    "Content-Type": "application/json",
    "X-Norg-Site-Id": env.SITE_ID || "",
    "X-Norg-Site-Key": env.NORG_SITE_KEY || "",
    "X-Norg-Edge-Version": EDGE_SCRIPT_VERSION,
  };
}

/**
 * Base URL for this site's mirror objects on the edge-content receptionist.
 *
 * @param {Object} env Config object.
 * @returns {string} Content base with the site id appended, no trailing slash.
 */
export function contentStem(env) {
  const base = binding(env, "NORG_CONTENT_BASE").replace(/\/+$/, "");
  return `${base}/${env.SITE_ID || ""}`;
}

/**
 * Is this install configured enough to do anything at all?
 *
 * Rule 3 of the worker contract: SITE_ID + NORG_SITE_KEY are compulsory, and
 * without both, every NORG endpoint refuses this install, so the correct
 * behaviour is total passthrough rather than a stream of doomed calls.
 *
 * @param {Object} env Config object.
 * @returns {boolean} True when both credentials are present.
 */
export function isConfigured(env) {
  return Boolean(env.SITE_ID && env.NORG_SITE_KEY);
}

export { CONFIG_HEADERS as __test_CONFIG_HEADERS };
