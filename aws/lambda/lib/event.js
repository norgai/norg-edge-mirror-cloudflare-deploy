/**
 * CloudFront origin-request event <-> WHATWG Request/Response adapter.
 *
 * @description Translates Lambda@Edge event shapes to the fetch API the router
 * is written against.
 *
 * The router logic is a port of the Cloudflare worker, which is written against
 * `Request`/`Response`. Rather than rewrite that logic in CloudFront's event
 * vocabulary — which would make the two providers impossible to diff — this
 * module adapts at the boundary and the router stays recognisably the same
 * file.
 *
 * Three CloudFront rules are enforced here, and getting any of them wrong turns
 * a working install into a 502 on the customer's site:
 *
 *  1. A generated origin-request response is capped at 1 MB INCLUDING headers.
 *     Over that, CloudFront returns 502 rather than truncating, so
 *     `toCloudFrontResponse` refuses instead and the caller falls back to the
 *     origin.
 *  2. Some headers are read-only or blacklisted in a generated response;
 *     returning one is a validation error, again a 502. They are dropped.
 *  3. A body must be a string. Anything that is not valid UTF-8 has to travel
 *     base64 with `bodyEncoding` set to match.
 */

// CloudFront rejects a generated response carrying any of these. The x-amz-cf-*,
// x-amzn-* and x-edge-* families are CloudFront's own; the rest are hop-by-hop
// headers a CDN must own. Matched case-insensitively, prefixes included.
const DISALLOWED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-cache",
  "x-forwarded-proto",
  "x-real-ip",
]);

const DISALLOWED_RESPONSE_PREFIXES = ["x-amz-cf-", "x-amzn-", "x-edge-", "x-accel-"];

// Generated origin-request responses cap at 1 MB including headers. The margin
// covers the header block and base64 expansion so the check can be made against
// the body alone, cheaply, before serialising.
const MAX_GENERATED_BODY_BYTES = 900 * 1024;

/**
 * Is this header forbidden in a generated CloudFront response?
 *
 * @param {string} name Lower-cased header name.
 * @returns {boolean} True when CloudFront would reject it.
 */
function isDisallowedResponseHeader(name) {
  if (DISALLOWED_RESPONSE_HEADERS.has(name)) return true;
  return DISALLOWED_RESPONSE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build a `Headers` from CloudFront's header map.
 *
 * @param {Object} cfHeaders CloudFront headers ({name: [{key, value}]}).
 * @returns {Headers} Equivalent fetch headers.
 */
export function toHeaders(cfHeaders) {
  const headers = new Headers();
  for (const entries of Object.values(cfHeaders || {})) {
    for (const entry of entries) headers.append(entry.key, entry.value);
  }
  return headers;
}

/**
 * Build CloudFront's header map from a `Headers`.
 *
 * @param {Headers} headers Response headers.
 * @returns {Object} CloudFront header map, forbidden headers omitted.
 */
export function fromHeaders(headers) {
  const cfHeaders = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (isDisallowedResponseHeader(lower)) continue;
    cfHeaders[lower] = [{ key: name, value }];
  }
  return cfHeaders;
}

/**
 * Absolute URL of a CloudFront request.
 *
 * The Host header is the customer's own domain, which is what every path test
 * and every event we report must see — never the distribution domain.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @returns {string} Absolute https URL.
 */
export function requestUrl(cfRequest) {
  const host =
    cfRequest.headers?.host?.[0]?.value ||
    cfRequest.origin?.custom?.domainName ||
    "localhost";
  const query = cfRequest.querystring ? `?${cfRequest.querystring}` : "";
  return `https://${host}${cfRequest.uri}${query}`;
}

/**
 * Adapt a CloudFront request into a `Request` the router can read.
 *
 * The body is deliberately not carried: `include-body` is off for this
 * association, and the only body-bearing path (an MCP POST) is forwarded by
 * re-reading it from the event where present.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @returns {Request} Request view of the same call.
 */
export function toRequest(cfRequest) {
  const init = { method: cfRequest.method, headers: toHeaders(cfRequest.headers) };
  if (cfRequest.method !== "GET" && cfRequest.method !== "HEAD" && cfRequest.body?.data) {
    init.body =
      cfRequest.body.encoding === "base64"
        ? Buffer.from(cfRequest.body.data, "base64")
        : cfRequest.body.data;
  }
  return new Request(requestUrl(cfRequest), init);
}

/**
 * Client IP of the caller, for CIDR verification.
 *
 * CloudFront populates `clientIp` itself; it is not spoofable by a header, which
 * is why it is preferred over anything in `x-forwarded-for`.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @returns {string} Client IP address.
 */
export function clientIp(cfRequest) {
  return cfRequest.clientIp || "";
}

/**
 * Adapt a `Response` into a CloudFront generated response.
 *
 * Returns null — rather than throwing or truncating — when the body exceeds
 * what CloudFront will accept, so the caller can degrade to the origin. That
 * refusal is the whole reason this returns a nullable.
 *
 * @param {Response} response Response to hand back to CloudFront.
 * @returns {Promise<?Object>} CloudFront response, or null if it will not fit.
 */
export async function toCloudFrontResponse(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_GENERATED_BODY_BYTES) return null;

  const text = buffer.toString("utf8");
  // A lossless round trip proves the bytes were UTF-8; anything else (a PDF
  // sibling, an image) has to travel base64.
  const isUtf8 = Buffer.compare(Buffer.from(text, "utf8"), buffer) === 0;

  return {
    status: String(response.status),
    statusDescription: response.statusText || "",
    headers: fromHeaders(response.headers),
    body: isUtf8 ? text : buffer.toString("base64"),
    bodyEncoding: isUtf8 ? "text" : "base64",
  };
}

/**
 * Hand the request back to CloudFront untouched, so it proceeds to the origin.
 *
 * This is the CloudFront equivalent of the Cloudflare worker's `fetch(request)`
 * passthrough, and it is the terminal state of every failure path in the
 * router. Note the asymmetry that makes it load-bearing: on Cloudflare a thrown
 * error still ends at the origin because the catch calls fetch, whereas on
 * Lambda@Edge a throw or a timeout is a 502 on the customer's site. Every exit
 * must route through here.
 *
 * @param {Object} cfRequest CloudFront request object, mutated in place or not.
 * @returns {Object} The same request object.
 */
export function passthrough(cfRequest) {
  return cfRequest;
}

export { MAX_GENERATED_BODY_BYTES as __test_MAX_GENERATED_BODY_BYTES };
