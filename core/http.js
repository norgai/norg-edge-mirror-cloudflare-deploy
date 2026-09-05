/**
 * The one seam every provider's outbound calls pass through.
 *
 * @description Lets an adapter supply how a fetch to NORG is actually made.
 *
 * Most edge runtimes accept a bare `fetch(url)` — Cloudflare, Lambda@Edge and
 * Vercel all do. Fastly does not: every request must name a declared backend
 * (`fetch(url, { backend })`) unless the service has dynamic backends switched
 * on, which is an account-level toggle we would rather not require.
 *
 * Rather than teach core about backends, or force every provider onto dynamic
 * backends, an adapter may put its own fetch on the config object as
 * `EDGE_FETCH`. Core calls through here and stays provider-neutral; a runtime
 * that needs no special handling sets nothing and gets global fetch.
 *
 * The seam is deliberately this thin. It is a function on the config object,
 * not a registry or a class, because exactly one behaviour varies.
 */

/**
 * Make an outbound request on behalf of the router.
 *
 * @param {Object} env Install config, which may carry EDGE_FETCH.
 * @param {string} url Absolute URL to request.
 * @param {Object} [init] Standard fetch init.
 * @returns {Promise<Response>} The response.
 */
export function edgeFetch(env, url, init) {
  const impl = env && env.EDGE_FETCH;
  return impl ? impl(url, init) : fetch(url, init);
}

/**
 * An abort signal that fires after `ms`, where the runtime provides one.
 *
 * WHY THIS EXISTS. Fastly's js-compute runtime does not implement
 * AbortController/AbortSignal at all, so a bare `AbortSignal.timeout(ms)` at a
 * call site throws ReferenceError on Fastly — inside the try/catch of whatever
 * is calling it, which turns every outbound NORG call into a silent failure.
 * That was not hypothetical: it made the feed refresh fail on every request, so
 * the install never became entitled and passed the whole site through forever,
 * looking exactly like a service that was not installed.
 *
 * Returning undefined is safe: `fetch` ignores an undefined signal. On Fastly
 * the bound is enforced instead by the per-backend connect/first-byte timeouts
 * declared in fastly.toml, which is that platform's own mechanism for this.
 *
 * @param {number} ms Timeout in milliseconds.
 * @returns {AbortSignal|undefined} A timeout signal, or undefined if the
 *   runtime has no AbortSignal.
 */
export function timeoutSignal(ms) {
  return typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}
