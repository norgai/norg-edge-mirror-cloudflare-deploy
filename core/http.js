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
