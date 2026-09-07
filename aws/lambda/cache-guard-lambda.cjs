/**
 * NORG edge router — origin-response cache guard (Lambda@Edge).
 *
 * @description Stops a non-human cache bucket from ever storing an origin page.
 *
 * WHY THIS EXISTS. The viewer-request stamp (`x-norg-agent`) is a deliberate
 * SUPERSET: a spoofed `curl -A GPTBot`, a never_divert crawler and a headless
 * browser all land in the "1" bucket alongside a genuinely verified agent. On a
 * cache miss they reach the router, fail verification, and are passed through
 * to the origin — and CloudFront then caches THAT origin response under
 * (url, agent=1) for whatever TTL the origin's Cache-Control declares. Every
 * later verified crawler is a cache HIT on that entry: the router never runs,
 * and it is served the origin page. On an origin that sends max-age, the first
 * bot-shaped request suppresses the mirror for the TTL, and anyone can force it.
 *
 * THE RULE: only the confidently-human bucket ("0") may cache origin bytes. Any
 * other value — "1", "probe", or absent — gets `private, no-store` unless the
 * response already came from NORG (it carries X-Norg-Edge and is no-store
 * already). Origin-request functions cannot touch the response, which is why
 * this is a separate origin-response function rather than a line in the router.
 *
 * COST. It runs once per origin fetch in a non-human bucket, at 128 MB for a
 * few milliseconds. A generated response from the router does NOT trigger an
 * origin-response event, so the mirror path pays nothing extra.
 *
 * NEVER BREAKS THE SITE. Every path returns the response, touched or not; the
 * try/catch is load-bearing because a throw here is a 502 on the customer's
 * site. Plain CommonJS with no imports because it is inlined into the
 * CloudFormation template (4 KB ceiling) rather than fetched from S3.
 */

"use strict";

/**
 * Should this response be allowed into the CloudFront cache?
 *
 * @param {string|undefined} bucket Value of x-norg-agent on the origin request.
 * @param {boolean} norgServed Whether the response carries X-Norg-Edge.
 * @returns {boolean} True only for the human bucket, or a NORG-served body.
 */
function cacheable(bucket, norgServed) {
  return bucket === "0" || norgServed;
}

/**
 * Lambda@Edge origin-response entry point.
 *
 * @param {Object} event CloudFront origin-response event.
 * @returns {Promise<Object>} The response, marked no-store where required.
 */
exports.handler = async function handler(event) {
  var response = event.Records[0].cf.response;
  try {
    var request = event.Records[0].cf.request;
    var stamp = request.headers["x-norg-agent"];
    var bucket = stamp && stamp[0] ? stamp[0].value : undefined;
    var norgServed = Boolean(response.headers["x-norg-edge"]);

    if (!cacheable(bucket, norgServed)) {
      response.headers["cache-control"] = [
        { key: "Cache-Control", value: "private, no-store" },
      ];
      // Expires is the one header that can outvote a missing Cache-Control;
      // with no-store present it is redundant and only invites confusion.
      delete response.headers["expires"];
    }
  } catch (e) {
    // Fall through with the response untouched. Rule 1.
  }
  return response;
};

exports.__test_cacheable = cacheable;
