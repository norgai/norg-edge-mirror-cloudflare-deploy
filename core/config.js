/**
 * Install configuration helpers, shared by every CDN provider.
 *
 * @description Provider-neutral reads over a binding-shaped config object.
 *
 * Each provider supplies config differently — Cloudflare has worker bindings,
 * Lambda@Edge has none at all and uses CloudFront origin custom headers, and
 * others use edge dictionaries or KV. That difference is confined to the
 * provider's own adapter, which produces a plain object; everything below reads
 * that object and is identical everywhere.
 *
 * The script version lives ON the config object rather than as a constant here,
 * because it is per-provider: each deployable artifact is versioned and pinned
 * separately by content-craft. The adapter injects it.
 */

import { BINDING_DEFAULTS } from "./constants.mjs";

/**
 * Resolve a binding, falling back to its baked default.
 *
 * Only an ABSENT binding takes the default; an explicitly-set value is returned
 * unchanged, so a deliberate empty string survives.
 *
 * @param {Object} env Config object from the provider adapter.
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
 * @param {Object} env Config object, carrying EDGE_SCRIPT_VERSION.
 * @returns {Object} Header map for a control call.
 */
export function controlHeaders(env) {
  return {
    "Content-Type": "application/json",
    "X-Norg-Site-Id": env.SITE_ID || "",
    "X-Norg-Site-Key": env.NORG_SITE_KEY || "",
    "X-Norg-Edge-Version": env.EDGE_SCRIPT_VERSION || "unknown",
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
 * without both every NORG endpoint refuses this install — so the correct
 * behaviour is total passthrough rather than a stream of doomed calls.
 *
 * @param {Object} env Config object.
 * @returns {boolean} True when both credentials are present.
 */
export function isConfigured(env) {
  return Boolean(env.SITE_ID && env.NORG_SITE_KEY);
}
