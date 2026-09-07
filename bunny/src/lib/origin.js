/**
 * Talking to the customer's origin, and handing control back to Bunny.
 *
 * @description Bunny adapter for origin fetches and passthrough.
 *
 * Bunny's middleware contract sits between the two shapes the other ports use.
 * `onOriginRequest` may return either a Response (short-circuit, the visitor
 * gets it) or a Request (Bunny goes and fetches it) — so "serve the origin" is
 * a SENTINEL, as on Lambda@Edge, rather than a real fetch as on Fastly and
 * Cloudflare. That is strictly better than CloudFront's version of the same
 * shape, because the platform's own origin machinery does the fetch: retries,
 * the configured host header and the origin shield all still apply, and there
 * is nothing for this code to get wrong about the Host header.
 *
 * The one path that genuinely needs the origin's BYTES is the strip fallback,
 * which has to measure the page before deciding whether stripping it helps.
 * That one does its own fetch, and it can do so safely because the request
 * Bunny hands the hook is already pointed at the origin URL.
 */

import { LOOP_GUARD_HEADER } from "../../../core/constants.mjs";

/**
 * Sentinel meaning "let Bunny fetch the origin, unchanged".
 *
 * A frozen object rather than a string so it can never collide with a
 * legitimate value, and identity comparison is the only test used.
 */
export const PASSTHROUGH = Object.freeze({ norgEdge: "passthrough" });

/**
 * Fetch the customer's origin and return its response.
 *
 * The request handed to the hook is already origin-pointed, so this is a
 * verbatim replay with the loop guard added. Never throws: a Bunny subrequest
 * to an unreachable origin rejects, and every caller here is on a path whose
 * correct answer is then "let the platform serve the origin" (rule 1).
 *
 * @param {Request} request Origin-pointed request from the middleware hook.
 * @param {number} timeoutMs Abort budget in milliseconds.
 * @returns {Promise<?Response>} Origin response, or null when unreachable.
 */
export async function fetchOrigin(request, timeoutMs) {
  try {
    const headers = new Headers(request.headers);
    headers.set(LOOP_GUARD_HEADER, "1");
    return await fetch(new Request(request.url, { method: request.method, headers }), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    console.error("norg edge origin fetch failed", e);
    return null;
  }
}
