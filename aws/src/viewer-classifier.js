/**
 * NORG edge router — viewer-request cache-key stamp (CloudFront Function).
 *
 * Sets `x-norg-agent` so agent traffic and human traffic occupy different cache
 * entries. The distribution's cache policy must include this header in the
 * cache key, or nothing here has any effect.
 *
 * WHY THIS EXISTS. On Cloudflare the worker runs before the cache on every
 * request, so it sees everything. CloudFront looks up its cache BETWEEN
 * viewer-request and origin-request, and the router is an origin-request
 * function — so it only runs on a cache MISS. Once a human has warmed the cache
 * for a page, a later GPTBot request for the same URL is a cache HIT, the
 * router never runs, and the agent silently gets the origin. The whole feature
 * fails, quietly, on exactly the popular pages that matter most.
 *
 * WHY A COARSE TEST IS SAFE. This function does not decide what to serve — it
 * only decides which cache bucket a request lands in. The router still requires
 * an authenticated feed, a published serving_policy and a verified source IP
 * before anything is diverted, so rule 3 is untouched and no local pattern list
 * is being trusted here.
 *
 * The two directions of error are NOT symmetric, and that asymmetry is the
 * whole design:
 *
 *   stamped "1" but actually human -> one extra cache variant and one extra
 *       Lambda invocation. Costs money, breaks nothing.
 *   stamped "0" but actually an agent -> the agent may be served a human's
 *       cached page and the router never runs. The feature fails silently.
 *
 * So the test is deliberately lopsided: stamp "0" ONLY for a user-agent that is
 * confidently an ordinary browser, and stamp "1" for everything else, including
 * an absent user-agent. Over-stamping is the intended behaviour, not sloppiness
 * — the set of requests marked as agents must be a SUPERSET of everything the
 * router might divert.
 *
 * Runtime: cloudfront-js-2.0. No network, no async, 10 KB limit. Written in
 * conservative ES5 so it also runs unchanged on cloudfront-js-1.0.
 */

// Tokens that never appear in an ordinary browser user-agent, and do appear in
// crawler and scripted-client ones. "compatible;" is included on purpose: every
// major crawler uses the "Mozilla/5.0 (compatible; Name/1.0; +url)" form, and
// among real browsers only legacy IE does — which is worth one extra cache
// variant.
var BOT_MARKERS = [
  "bot", "crawl", "spider", "slurp", "scrape", "fetch", "agent",
  "compatible;", "http://", "https://", "headless", "preview",
  "python", "curl", "wget", "java/", "okhttp", "axios", "node-fetch",
  "go-http", "ruby", "perl", "libwww", "httpx", "aiohttp",
];

// A real browser presents Mozilla/5.0 AND one of these engine or brand tokens.
var BROWSER_MARKERS = ["chrome/", "safari/", "firefox/", "edg/", "opr/", "trident/"];

/**
 * Does the string contain any of the needles?
 *
 * @param {string} haystack Lower-cased subject.
 * @param {Array} needles Tokens to look for.
 * @returns {boolean} True on the first match.
 */
function containsAny(haystack, needles) {
  for (var i = 0; i < needles.length; i++) {
    if (haystack.indexOf(needles[i]) !== -1) return true;
  }
  return false;
}

/**
 * Is this confidently an ordinary browser?
 *
 * @param {string} userAgent Raw User-Agent header.
 * @returns {boolean} True only when the shape is unambiguously a browser.
 */
function isOrdinaryBrowser(userAgent) {
  if (!userAgent) return false;
  var ua = userAgent.toLowerCase();
  if (ua.indexOf("mozilla/5.0") !== 0) return false;
  if (containsAny(ua, BOT_MARKERS)) return false;
  return containsAny(ua, BROWSER_MARKERS);
}

/**
 * Stamp the cache-key header on a viewer request.
 *
 * @param {Object} event CloudFront Functions event.
 * @returns {Object} The request, with x-norg-agent set.
 */
function handler(event) {
  var request = event.request;
  var headers = request.headers || {};
  var querystring = request.querystring || {};

  var value;
  if (headers["x-norg-edge-check"]) {
    // A health probe answers with install state, not page content. Its own
    // bucket keeps it from ever colliding with a real page's cache entry.
    value = "probe";
  } else if (querystring.agent && querystring.agent.value === "true") {
    // ?agent=true forces the mirror, so it must not share a human's entry.
    value = "1";
  } else {
    var userAgent = headers["user-agent"] ? headers["user-agent"].value : "";
    value = isOrdinaryBrowser(userAgent) ? "0" : "1";
  }

  request.headers["x-norg-agent"] = { value: value };
  return request;
}
