/**
 * The visit header: everything NORG needs to record an agent visit, carried on
 * the mirror fetch the router already awaits.
 *
 * @description Builds `X-Norg-Visit`, so the receptionist records the event.
 *
 * On Cloudflare the worker records each visit itself through `ctx.waitUntil`.
 * A runtime with no such primitive cannot: Lambda@Edge freezes the moment the
 * handler returns, so an un-awaited call is lost and an awaited one is a wait
 * the visitor pays. The receptionist, which runs on Cloudflare and already
 * fires an event on every mirror it serves, records the visit instead — from
 * the details in this header — through its own deferred-work primitive, never
 * in front of the response.
 *
 * One header, base64url JSON, capped at 4 KB. Nulls are omitted rather than
 * sent, and the user agent is truncated first when the cap is reached: it is
 * the one field a hostile client controls the size of.
 */

// Receptionist-side limit on the decoded document; anything over is ignored
// there and the placeholder event is written instead.
const MAX_HEADER_BYTES = 4 * 1024;
const MAX_USER_AGENT_CHARS = 512;
// The widest column NORG stores any other string field in.
const MAX_FIELD_CHARS = 255;

/**
 * Geo and connection attributes CloudFront exposes as request headers.
 *
 * Cloudflare hands these over as `request.cf`; CloudFront adds them as
 * `CloudFront-Viewer-*` headers, but ONLY when the distribution's origin
 * request policy asks for them, so every field is independently optional and a
 * missing one must read as null rather than break the event.
 *
 * @param {Headers} headers Request headers.
 * @returns {Object} Event fields describing where the request came from.
 */
export function viewerAttributes(headers) {
  const value = (name) => headers.get(name) || null;
  return {
    ip_country: value("cloudfront-viewer-country"),
    ip_city: value("cloudfront-viewer-city"),
    asn: value("cloudfront-viewer-asn"),
    // CloudFront publishes no AS organisation name and no edge-location id in
    // request headers; both are Cloudflare-only. Null keeps the event shape
    // identical across providers rather than inventing a value.
    as_organization: null,
    colo: null,
    http_protocol: value("cloudfront-viewer-http-version"),
    // CloudFront publishes the whole negotiated suite here —
    // `TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake` — where Cloudflare's
    // `request.cf.tlsVersion` is just `TLSv1.3`. NORG stores the field in 20
    // characters, so only the protocol is sent.
    tls_version: firstField(value("cloudfront-viewer-tls")),
  };
}

/**
 * The first colon-separated field of a header value.
 *
 * @param {?string} raw Header value, or null.
 * @returns {?string} Text before the first colon, or null.
 */
function firstField(raw) {
  return raw ? raw.split(":")[0] : null;
}

/**
 * Encode a document as base64url, the shape the receptionist decodes.
 *
 * @param {Object} document Plain JSON-serialisable object.
 * @returns {string} Header value.
 */
function encode(document) {
  return Buffer.from(JSON.stringify(document), "utf8").toString("base64url");
}

/**
 * The `X-Norg-Visit` header value for one classified request.
 *
 * `served` is the label the router will use if the receptionist answers 200;
 * `servedOnMiss` is the label for a 404, which the router then answers from
 * the origin (stripped or untouched) without a second NORG call.
 *
 * @param {Request} request Incoming request.
 * @param {Object} classification Bot classification.
 * @param {string} served Label on a hit: mirror, agentic_path, agent_param_override.
 * @param {string} servedOnMiss Label on a miss: stripped, origin, or the *_miss label.
 * @returns {string} Header value, never over MAX_HEADER_BYTES.
 */
export function visitHeader(request, classification, served, servedOnMiss) {
  const userAgent = request.headers.get("user-agent") || "";
  const document = {
    user_agent: userAgent.slice(0, MAX_USER_AGENT_CHARS),
    is_ai_bot: classification.is_ai_bot,
    bot_name: classification.bot_name,
    company: classification.company,
    purpose: classification.purpose,
    served,
    served_on_miss: servedOnMiss,
  };
  for (const [key, value] of Object.entries(viewerAttributes(request.headers))) {
    if (value !== null) document[key] = String(value).slice(0, MAX_FIELD_CHARS);
  }
  let encoded = encode(document);
  if (encoded.length > MAX_HEADER_BYTES) {
    encoded = encode({ ...document, user_agent: userAgent.slice(0, 128) });
  }
  return encoded;
}

export { MAX_HEADER_BYTES as __test_MAX_HEADER_BYTES };
