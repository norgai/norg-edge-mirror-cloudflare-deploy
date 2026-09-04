/**
 * Talking to the customer's origin, and handing control back to Fastly.
 *
 * @description Fastly adapter for origin fetches and passthrough.
 *
 * This is where Fastly is markedly simpler than CloudFront, and the difference
 * is worth stating because it removes two whole classes of bug we hit there:
 *
 *  - **Passthrough is a real fetch, not a sentinel.** On Lambda@Edge "serve the
 *    origin" means returning a mutated request object and letting CloudFront go
 *    fetch it, which is why the Host header had to be rewritten and why an
 *    unhandled throw became a 502. Here `fetch(request, { backend })` returns a
 *    Response like any other, so the top-level catch can simply return the
 *    origin — the same shape as the Cloudflare worker.
 *  - **No generated-response size cap.** CloudFront refuses a generated
 *    origin-request response over 1 MB. Fastly has a 128 MB heap and streams,
 *    so a mirror of any realistic size is returned inline and always carries
 *    its X-Norg-Edge headers. The whole origin-switch fallback that CloudFront
 *    needed does not exist here.
 */

import { LOOP_GUARD_HEADER } from "../../../core/constants.mjs";

/** Backend name for the customer's own origin, defined in fastly.toml. */
export const ORIGIN_BACKEND = "customer_origin";

/**
 * Fetch the customer's origin.
 *
 * Carries the viewer's headers so the origin sees the request it would have
 * seen anyway, plus the loop guard so a misconfigured service cannot recurse
 * into this code.
 *
 * Deliberately does NOT rewrite the Host header. Fastly sends the request's own
 * Host to the backend, which is what a host-aware origin needs — absolute URLs,
 * canonical tags, cookie domains and auth middleware all key off it. (On
 * CloudFront the platform forces the opposite, and it bounced every visitor off
 * the CDN domain until we understood why.)
 *
 * @param {Request} request Incoming request.
 * @returns {Promise<Response>} Origin response.
 */
export function fetchOrigin(request) {
  const headers = new Headers(request.headers);
  headers.set(LOOP_GUARD_HEADER, "1");
  return fetch(new Request(request, { headers }), { backend: ORIGIN_BACKEND });
}

/**
 * Pass the request to the origin untouched.
 *
 * The terminal state of every failure path, and — unlike CloudFront — an
 * ordinary Response, so nothing special is needed to make rule 1 hold.
 *
 * @param {Request} request Incoming request.
 * @returns {Promise<Response>} Origin response.
 */
export function passthrough(request) {
  return fetch(request, { backend: ORIGIN_BACKEND });
}
