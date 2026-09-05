/**
 * NORG.ai Content-Craft Platform — Edge Router (Fastly Compute) entry point.
 *
 * @description Registers the fetch handler and wires the platform adapters.
 *
 * Deliberately thin. Everything that can be tested without the Fastly toolchain
 * lives in router.js; this file holds only what needs the platform — the
 * Config/Secret store reads and the fetch-event registration — because a
 * `fastly:` import cannot be resolved by Node and a top-level
 * `addEventListener` cannot run there.
 */

import { isConfigured } from "../../core/config.js";
import { flushDeferred } from "../../core/deferred.js";

import { readConfig } from "./lib/config.js";
import { backendFetch, handleRequest } from "./router.js";
import { safePassthrough } from "./lib/origin.js";

/**
 * Handle one request.
 *
 * The catch is the whole safety story. On Fastly it is simpler than
 * Lambda@Edge — passthrough is a real Response rather than a mutated request
 * object — but it is NOT free: a Fastly backend error rejects rather than
 * resolving, so the catch must use safePassthrough, which cannot itself throw.
 * A plain passthrough here let a down origin escape as a 500 we generated.
 *
 * @param {FetchEvent} event Fastly fetch event.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function app(event) {
  const request = event.request;
  try {
    const env = await readConfig();
    // Rule 3: without both credentials every NORG call would be refused, so the
    // correct behaviour is to do nothing rather than fail slowly on each one.
    if (!isConfigured(env)) return safePassthrough(request);

    env.EDGE_FETCH = backendFetch(env);
    const response = await handleRequest(request, env, event.client.address);

    // Fastly has a real waitUntil, so the deferred queue drains behind the
    // response — no flush-on-next-invocation trick as on Lambda@Edge.
    event.waitUntil(flushDeferred());
    return response;
  } catch (e) {
    console.error("norg edge router error", e);
    return safePassthrough(request);
  }
}

addEventListener("fetch", (event) => event.respondWith(app(event)));
