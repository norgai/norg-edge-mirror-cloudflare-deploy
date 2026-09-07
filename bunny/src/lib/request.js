/**
 * Reading the viewer's identity out of a Bunny middleware request.
 *
 * @description Bunny adapter for client IP and the visitor-facing URL.
 *
 * Bunny hands `onOriginRequest` a request that is already pointed at the
 * ORIGIN: `ctx.request.url` reads `https://www.customer.com/path`, not the
 * hostname the visitor typed. That is convenient for fetching the origin and
 * wrong for everything else — the canonical Link headers, the `domain` field
 * on a visit event and the health probe all describe the visitor's URL. So the
 * two views are separated here rather than being confused downstream.
 *
 * WHAT BUNNY PUBLISHES ABOUT THE CLIENT, verified against a live pull zone on
 * 2026-09-07 by echoing the request headers back:
 *
 *   x-real-ip               the client address, set by Bunny
 *   x-forwarded-for         the same address
 *   cdn-host                the hostname the visitor asked for
 *   cdn-origin-host/-proto  the configured origin
 *   cdn-requestcountrycode  ISO country, cdn-requeststatecode for US/AU states
 *   cdn-serverzone/-serverid  the answering PoP
 *   cdn-ja4                 TLS fingerprint
 *   cdn-loopcount           proxy depth
 *
 * BOTH IP HEADERS ARE REPLACED, NOT APPENDED. A request carrying
 * `X-Forwarded-For: 1.2.3.4` and `X-Real-IP: 5.6.7.8` arrived at the script
 * with both headers reading the true client address, and a comma list
 * (`9.9.9.9, 8.8.8.8`) was discarded the same way. That is what makes gate 3
 * (verifiedSource) sound on Bunny: the address is the platform's, not the
 * caller's. If Bunny ever changes to appending, the LAST entry is still the
 * edge-observed one, which is why the fallback below reads from the end.
 *
 * Bunny publishes NO verified-bot signal of any kind — there is no equivalent
 * of Cloudflare's `request.cf.verifiedBotCategory` — so, exactly as on
 * CloudFront and Fastly, source verification is CIDR-only. A crawler whose
 * operator publishes no CIDR ranges is not diverted here. That is a capability
 * gap, and the direction of the failure is the safe one.
 */

/**
 * The client address Bunny observed, for the CIDR gate.
 *
 * @param {Request} request Request handed to the middleware hook.
 * @returns {string} Client IP, or "" when the platform published none.
 */
export function clientIp(request) {
  const real = (request.headers.get("x-real-ip") || "").trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for") || "";
  const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * The hostname the visitor actually asked for.
 *
 * `cdn-host` is Bunny's own record of it and is preferred; the Host header is
 * the fallback and still carries the visitor's hostname at this hook, because
 * the pull zone's origin host header is applied after the script runs.
 *
 * @param {Request} request Request handed to the middleware hook.
 * @returns {?string} Visitor hostname, or null when neither header is present.
 */
export function visitorHost(request) {
  const cdnHost = (request.headers.get("cdn-host") || "").trim();
  if (cdnHost) return cdnHost;
  const host = (request.headers.get("host") || "").trim();
  return host || null;
}

/**
 * The URL as the visitor sees it: origin-pointed path, visitor-facing host.
 *
 * @param {Request} request Request handed to the middleware hook.
 * @returns {URL} URL carrying the visitor's hostname.
 */
export function visitorUrl(request) {
  const url = new URL(request.url);
  const host = visitorHost(request);
  if (host) {
    url.host = host;
    url.protocol = "https:";
  }
  return url;
}
