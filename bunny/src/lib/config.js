/**
 * Install configuration, sourced from Bunny Edge Scripting environment values.
 *
 * @description Bunny adapter for the provider-neutral config in core/.
 *
 * Bunny splits configuration into two stores, and the split is the one this
 * artifact wants:
 *
 *  - **Environment variables** hold the plain values (site id, API URLs,
 *    flags). They are readable back through the API and the dashboard, which
 *    is correct for configuration.
 *  - **Environment secrets** hold NORG_SITE_KEY. Bunny will not return a
 *    secret's plaintext once it is written — `GET /compute/script/{id}/secrets`
 *    lists names and ids only — so it can be rotated or deleted but not read.
 *    That is the same guarantee as Fastly's Secret Store, stronger than a
 *    Cloudflare worker secret, and far stronger than CloudFront, where the key
 *    travels as an origin custom header.
 *
 * Both are read through `process.env` (Deno's `Deno.env.get` reads the same
 * table). The result is shaped exactly like the Cloudflare worker's `env`, so
 * everything in core/ reads it unchanged.
 */

/**
 * Version of this artifact, reported on every control call and heartbeat.
 *
 * Versioned independently of the other providers because it is a separate
 * deployable with its own pin; content-craft compares it against
 * EDGE_WORKER_VERSION_BUNNY.
 *
 * 0.2.0 — the 0.6.0 architecture shared with CloudFront: an ordinary browser,
 * a search crawler and a static asset are answered before the feed is read;
 * the router makes no call of its own to report a visit (the visit rides as a
 * header on the mirror fetch and NORG's content service records it, and on a
 * miss enqueues the render); the deferred queue and traffic heartbeat are
 * gone; and the installer keeps HTML out of the pull zone's cache by default
 * with an HTML-only edge rule rather than the zone-wide bypass.
 */
export const EDGE_SCRIPT_VERSION = "0.2.0";

// Environment names this install reads. Mirrors build_worker_bindings() in
// content-craft's install_service.py; adding a binding there means adding it
// here. NORG_SITE_KEY is included because on Bunny it is read from the same
// table as the plain values — it is stored as a SECRET, not a variable.
const ENV_NAMES = [
  "SITE_ID",
  "NORG_SITE_KEY",
  "NORG_API_URL",
  "NORG_CONTENT_BASE",
  "STRIP_FALLBACK_ENABLED",
  "EDGE_DISABLED",
  "LAZY_RENDER_ENABLED",
  "EDGE_ENV",
  "EDGE_EVENTS_VERBOSE",
];

/**
 * Read one environment value, treating blank as absent.
 *
 * WHY BLANK IS ABSENT HERE, unlike core's `binding()`. On Cloudflare a binding
 * that is not set simply does not exist, so `undefined` and "deliberately
 * empty" are distinguishable and core honours the difference. Bunny declares
 * variables up front with a DefaultValue, so an optional variable left unset
 * arrives as "" rather than undefined — and "" for NORG_API_URL would send
 * every control call to a relative URL instead of taking the baked default.
 * Collapsing blank to absent restores core's intended behaviour; nothing this
 * artifact reads has a meaningful empty value.
 *
 * @param {Object} table Environment table (process.env or a test double).
 * @param {string} name Variable name.
 * @returns {?string} The value, or undefined when unset or blank.
 */
function readEnvValue(table, name) {
  const value = table[name];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Build the binding-shaped config object for this invocation.
 *
 * A missing value is not an error: an unconfigured install must be inert
 * rather than throwing, so the caller sees an env without credentials and
 * passes every request through (rule 3).
 *
 * @param {Object} table Environment table (process.env or a test double).
 * @returns {Object} Binding-shaped config object.
 */
export function readConfig(table) {
  const env = { EDGE_SCRIPT_VERSION, EDGE_PLATFORM: "bunny" };
  for (const name of ENV_NAMES) {
    const value = readEnvValue(table || {}, name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}
