/**
 * NORG.ai Content-Craft Platform — Edge Router (Fastly Compute) entry point.
 *
 * @description Registers the fetch handler and wires the platform adapters.
 *
 * Deliberately thin. Everything that can be tested without the Fastly toolchain
 * lives in router.js; this file holds only what needs the platform — the
 * Config/Secret store reads, the cache override, the keep-alive and the
 * fetch-event registration — because a `fastly:` import cannot be resolved by
 * Node and a top-level `addEventListener` cannot run there.
 */

import { CacheOverride } from "fastly:cache-override";

import { isConfigured } from "../../core/config.js";

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
 * Three platform hooks ride on the config object so router.js stays free of
 * `fastly:` imports: EDGE_FETCH names a backend on every NORG call,
 * EDGE_PASS_CACHE keeps pages out of Fastly's cache, and EDGE_KEEPALIVE hands
 * background work — the stale-feed refresh and the opt-in passthrough event —
 * to `event.waitUntil`, so it lands after the response and the visitor feels
 * none of it. Agent visits need no background work at all: the receptionist
 * records them from the header on the mirror fetch.
 *
 * @param {FetchEvent} event Fastly fetch event.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function app(event) {
  const request = event.request;
  const env = { EDGE_PASS_CACHE: new CacheOverride("pass") };
  try {
    Object.assign(env, await readConfig());
    // Rule 3: without both credentials every NORG call would be refused, so the
    // correct behaviour is to do nothing rather than fail slowly on each one.
    if (!isConfigured(env)) return safePassthrough(request, env);

    env.EDGE_FETCH = backendFetch(env);
    env.EDGE_KEEPALIVE = (promise) => event.waitUntil(promise);
    return await handleRequest(request, env, event.client.address);
  } catch (e) {
    console.error("norg edge router error", e);
    return safePassthrough(request, env);
  }
}

addEventListener("fetch", (event) => event.respondWith(app(event)));
