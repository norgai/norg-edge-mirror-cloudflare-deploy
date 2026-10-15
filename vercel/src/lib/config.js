/**
 * Install configuration for the Vercel adapter.
 *
 * @description Builds core's binding-shaped config from env vars and options.
 *
 * A Vercel project has one environment table shared by the customer's whole
 * application, so every name this package reads is prefixed `NORG_` — a bare
 * `SITE_ID` (the Cloudflare binding name) would collide with the customer's own
 * variables. The table below maps each prefixed name onto the binding name
 * core/ reads, so nothing in core/ changes for this provider.
 *
 * Every read is a STATIC `process.env.NAME` property access, never
 * `process.env[name]`. Next.js and Vercel's middleware bundlers resolve
 * environment variables for the Edge runtime by the literal property name; a
 * computed lookup is not guaranteed to see them.
 *
 * Options passed to the factory win over the environment, so an application
 * that keeps its secrets somewhere else can hand them over directly.
 */

import { BINDING_DEFAULTS } from "../../../core/constants.mjs";

/**
 * Version of this artifact, reported on every control call and heartbeat.
 *
 * Versioned independently of the other providers because it is a separate
 * deployable; content-craft compares it against EDGE_WORKER_VERSION_VERCEL.
 * tests/package.test.mjs fails if this disagrees with package.json.
 */
export const EDGE_SCRIPT_VERSION = "0.1.0";

export const EDGE_PLATFORM = "vercel";

/**
 * The environment, read by literal name.
 *
 * @returns {Object} Prefixed name -> raw value (possibly undefined).
 */
function readProcessEnv() {
  if (typeof process === "undefined" || !process.env) return {};
  return {
    NORG_SITE_ID: process.env.NORG_SITE_ID,
    NORG_SITE_KEY: process.env.NORG_SITE_KEY,
    NORG_API_URL: process.env.NORG_API_URL,
    NORG_CONTENT_BASE: process.env.NORG_CONTENT_BASE,
    NORG_EDGE_ENV: process.env.NORG_EDGE_ENV,
    NORG_EDGE_DISABLED: process.env.NORG_EDGE_DISABLED,
    NORG_STRIP_FALLBACK_ENABLED: process.env.NORG_STRIP_FALLBACK_ENABLED,
    NORG_LAZY_RENDER_ENABLED: process.env.NORG_LAZY_RENDER_ENABLED,
    NORG_EDGE_EVENTS_VERBOSE: process.env.NORG_EDGE_EVENTS_VERBOSE,
  };
}

// Option name -> [environment name, core binding name].
const FIELDS = {
  siteId: ["NORG_SITE_ID", "SITE_ID"],
  siteKey: ["NORG_SITE_KEY", "NORG_SITE_KEY"],
  apiUrl: ["NORG_API_URL", "NORG_API_URL"],
  contentBase: ["NORG_CONTENT_BASE", "NORG_CONTENT_BASE"],
  env: ["NORG_EDGE_ENV", "EDGE_ENV"],
  disabled: ["NORG_EDGE_DISABLED", "EDGE_DISABLED"],
  stripFallback: ["NORG_STRIP_FALLBACK_ENABLED", "STRIP_FALLBACK_ENABLED"],
  lazyRender: ["NORG_LAZY_RENDER_ENABLED", "LAZY_RENDER_ENABLED"],
  eventsVerbose: ["NORG_EDGE_EVENTS_VERBOSE", "EDGE_EVENTS_VERBOSE"],
};

/**
 * One value as a trimmed string, with blank treated as absent.
 *
 * Blank is absent because a Vercel variable can be saved empty, and "" for
 * NORG_API_URL would send every control call to a relative URL instead of
 * taking core's baked default. Booleans from options become "true"/"false",
 * the shape core compares against.
 *
 * @param {*} value Raw value.
 * @returns {string|undefined} The value, or undefined when unset or blank.
 */
function clean(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/**
 * The NORG environment an install talks to, when not stated.
 *
 * Same rule as the WordPress plugin: the default API is production, a host
 * naming "test" is test, and anything else is "unknown" — which core's guards
 * refuse to treat as production.
 *
 * @param {Object} env Binding-shaped config.
 * @returns {string} "production" | "test" | "unknown".
 */
function derivedEnv(env) {
  const api = (env.NORG_API_URL || "").replace(/\/+$/, "");
  if (!api || api === BINDING_DEFAULTS.NORG_API_URL) return "production";
  return api.includes("test") ? "test" : "unknown";
}

/**
 * Build the binding-shaped config object for one request.
 *
 * A missing credential is not an error: an unconfigured install must be inert
 * rather than throwing, so the caller sees an env without credentials and
 * passes every request through (rule 3).
 *
 * @param {Object} [options] Factory options; each wins over its env var.
 * @param {Object} [table] Environment table (tests pass a double).
 * @returns {Object} Binding-shaped config object.
 */
export function readConfig(options = {}, table = readProcessEnv()) {
  const env = { EDGE_SCRIPT_VERSION, EDGE_PLATFORM };
  for (const [option, [envName, bindingName]] of Object.entries(FIELDS)) {
    const value = clean(options[option] ?? table[envName]);
    if (value !== undefined) env[bindingName] = value;
  }
  if (!env.EDGE_ENV) env.EDGE_ENV = derivedEnv(env);
  return env;
}
