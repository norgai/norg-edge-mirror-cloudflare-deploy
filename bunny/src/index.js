/**
 * NORG.ai Content-Craft Platform — Edge Router (Bunny) entry point.
 *
 * @description Registers the middleware hook and wires the platform adapters.
 *
 * Deliberately thin. Everything that can be tested without Bunny or Deno lives
 * in router.js; this file holds only what needs the platform — the SDK import,
 * the environment read and `Bunny.v1.waitUntil` — because the SDK specifier
 * cannot be resolved by Node and the registration call cannot run there.
 *
 * ONLY `onOriginRequest` IS REGISTERED, and that is a deliberate constraint
 * rather than an omission. Bunny's before-cache hooks (`onClientRequest` /
 * `onClientResponse`) exist only on pull zones with before-cache execution
 * enabled — a preview feature. Registering a hook the account cannot provide
 * makes the SDK throw at startup, and a middleware script that fails to start
 * makes the pull zone answer 400 for EVERY request, which is precisely the
 * "never break the customer's site" failure this artifact exists to avoid.
 * (Observed directly: a script registering `onClientRequest` on an account
 * without the preview 400ed the whole zone until the hook was removed.)
 *
 * The consequence is that the router runs on a cache MISS only, so the install
 * must disable the pull zone's cache. See the README, "The cache is the
 * hazard".
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk@0.12.1";
import process from "node:process";

import { isConfigured } from "../../core/config.js";
import { flushDeferred } from "../../core/deferred.js";

import { readConfig } from "./lib/config.js";
import { PASSTHROUGH } from "./lib/origin.js";
import { handleRequest } from "./router.js";

// Leaves a wide margin under Bunny's 30s CPU ceiling. Every network call the
// pipeline makes already carries its own AbortSignal budget, so reaching this
// means something the timeouts do not cover has hung — and the answer to that
// is still the customer's own page.
const WATCHDOG_MS = 15_000;

/**
 * Hand background work to the platform, when the platform offers somewhere.
 *
 * `Bunny.v1.waitUntil` keeps the isolate alive until the promise settles.
 * Under `deno run` locally there is no `Bunny` global, so the promise is left
 * to run unattended instead of throwing.
 *
 * @param {Promise<*>} promise Background work.
 * @returns {void}
 */
function keepAlive(promise) {
  const waitUntil = globalThis.Bunny?.v1?.waitUntil;
  if (typeof waitUntil === "function") waitUntil(promise);
  else promise.catch(() => {});
}

/**
 * Run the pipeline under a watchdog.
 *
 * @param {Request} request Origin-pointed request from the hook.
 * @param {Object} env Install config.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function raceWatchdog(request, env) {
  let watchdog;
  try {
    return await Promise.race([
      handleRequest(request, env),
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(PASSTHROUGH), WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Handle one origin request.
 *
 * The catch is the whole safety story, and on Bunny it is genuinely simple:
 * returning the request means "carry on to the origin as if this script were
 * not installed", and the platform's own origin machinery does the rest. So
 * every exit — success, thrown error, or a pipeline that took too long —
 * resolves to either a Response or the untouched request.
 *
 * @param {Object} ctx Middleware context carrying the request.
 * @returns {Promise<Request|Response>} A response, or the request to proxy.
 */
export async function onOriginRequest(ctx) {
  const request = ctx.request;
  try {
    const env = readConfig(process.env);
    // Rule 3: without both credentials every NORG call would be refused, so the
    // correct behaviour is to do nothing rather than fail slowly on each one.
    if (!isConfigured(env)) return request;

    // Gives work suspended when this isolate last went idle an event-loop turn
    // while the pipeline does its own awaits.
    const flushed = flushDeferred();
    const result = await raceWatchdog(request, env);
    await flushed;

    // Starts whatever this invocation queued, and asks Bunny to hold the
    // isolate open until it settles.
    keepAlive(flushDeferred());

    return result === PASSTHROUGH ? request : result;
  } catch (e) {
    console.error("norg edge router error", e);
    return request;
  }
}

// `url` is read only by `deno run` locally; in production Bunny proxies to the
// pull zone's configured origin and this value is ignored entirely. It is an
// environment value rather than a literal so the committed bundle names no
// hostname it does not own.
const LOCAL_ORIGIN_URL = process.env.LOCAL_DEV_ORIGIN_URL || "http://127.0.0.1:8081";

BunnySDK.net.http.servePullZone({ url: LOCAL_ORIGIN_URL }).onOriginRequest(onOriginRequest);
