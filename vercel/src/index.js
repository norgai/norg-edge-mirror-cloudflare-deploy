/**
 * NORG Edge Router for Vercel — framework-neutral entry point.
 *
 * @description createNorgEdge(): a (request, context) handler for any Vercel
 * project, usable as-is as Vercel Routing Middleware.
 *
 * The handler resolves to a Response when NORG answers the request, and to
 * `undefined` when the site should answer it — which is exactly what both
 * Vercel Routing Middleware and Next.js middleware read as "continue to the
 * application unchanged". Every failure resolves to `undefined` too: a thrown
 * error, a pipeline that runs past the watchdog, or a missing credential.
 */

import { isConfigured } from "../../core/config.js";

import { EDGE_SCRIPT_VERSION, readConfig } from "./lib/config.js";
import { handleRequest } from "./router.js";

// Each NORG call already carries its own timeout; reaching this means
// something they do not cover has hung. Well inside Vercel's limit for a
// middleware to begin its response.
const WATCHDOG_MS = 10_000;

/**
 * The platform's keep-alive, when the caller passed a context that has one.
 *
 * @param {Object} [context] Vercel request context or NextFetchEvent.
 * @returns {Function|undefined} waitUntil bound to its context.
 */
function keepAliveFrom(context) {
  const waitUntil = context && context.waitUntil;
  return typeof waitUntil === "function" ? waitUntil.bind(context) : undefined;
}

/**
 * Run a pipeline promise under a watchdog.
 *
 * The pipeline is given its rejection handler BEFORE the race. When the
 * watchdog wins, the race has settled and nothing awaits the pipeline any
 * more; a rejection from it later would then be unhandled — and on the
 * Node.js middleware runtime an unhandled rejection ends the server process,
 * which is the one outcome this package exists to rule out. Handled, a late
 * failure is a log line and nothing else.
 *
 * @param {Promise<?Response>} pipeline The running pipeline.
 * @param {number} watchdogMs Budget before "serve the site" wins.
 * @returns {Promise<?Response>} Response, or null.
 */
async function raceWatchdog(pipeline, watchdogMs) {
  const guarded = pipeline.catch((e) => {
    console.error("norg edge router error", e);
    return null;
  });
  let watchdog;
  try {
    return await Promise.race([
      guarded,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(null), watchdogMs);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Create the NORG edge handler.
 *
 * @param {Object} [options] Overrides; each wins over its NORG_* variable.
 * @param {string} [options.siteId] NORG Site ID (NORG_SITE_ID).
 * @param {string} [options.siteKey] NORG Site Key (NORG_SITE_KEY).
 * @param {string} [options.apiUrl] NORG API base (NORG_API_URL).
 * @param {string} [options.contentBase] Render base (NORG_CONTENT_BASE).
 * @param {string} [options.env] "production" | "test" (NORG_EDGE_ENV).
 * @param {boolean} [options.disabled] Kill switch (NORG_EDGE_DISABLED).
 * @param {boolean} [options.stripFallback] (NORG_STRIP_FALLBACK_ENABLED).
 * @param {boolean} [options.lazyRender] (NORG_LAZY_RENDER_ENABLED).
 * @param {Function} [options.getClientIp] Client-IP reader for hosts other
 *   than Vercel; on Vercel the platform's own header is used.
 * @returns {Function} (request, context?) => Promise<Response|undefined>.
 */
export function createNorgEdge(options = {}) {
  return async function norgEdge(request, context) {
    try {
      const env = readConfig(options);
      // Rule 3: without both credentials every NORG call would be refused.
      if (!isConfigured(env)) return undefined;
      const keepAlive = keepAliveFrom(context);
      if (keepAlive) env.EDGE_KEEPALIVE = keepAlive;
      const response = await raceWatchdog(handleRequest(request, env, options), WATCHDOG_MS);
      return response || undefined;
    } catch (e) {
      console.error("norg edge router error", e);
      return undefined;
    }
  };
}

export { EDGE_SCRIPT_VERSION as version };
export default createNorgEdge;

// Test-only export.
export { raceWatchdog as __test_raceWatchdog };
