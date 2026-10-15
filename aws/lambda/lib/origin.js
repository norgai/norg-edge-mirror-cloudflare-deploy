/**
 * Talking to the customer's own origin, and handing control back to CloudFront.
 *
 * @description Origin passthrough, direct origin reads, and origin switching.
 *
 * This is where the two providers differ most. On Cloudflare, "serve the
 * origin" is `fetch(request)` — a Response, like every other branch. On
 * CloudFront it is a different KIND of answer: returning the request object
 * unmodified, so CloudFront proceeds to the origin itself. That is not just a
 * style difference; it is faster (CloudFront streams and caches the response
 * without it passing through Lambda) and it is the only form that has no size
 * limit, which matters because a generated origin-request response is capped at
 * 1 MB.
 *
 * So the router returns either a `Response` or the PASSTHROUGH sentinel, and
 * three cases need this module:
 *
 *  - Plain passthrough: return PASSTHROUGH, touch nothing.
 *  - Origin-first artifacts and the strip fallback: the router must READ the
 *    origin body before deciding, so it fetches the origin itself.
 *  - A mirror too large to return as a generated response: point the request at
 *    NORG's receptionist instead and return PASSTHROUGH, so CloudFront fetches
 *    and streams the mirror with no size limit at all.
 */

import {
  HOSTNAME_PATTERN,
  LOOP_GUARD_HEADER,
  PUBLIC_HOST_HEADER,
} from "../../../core/constants.mjs";
import { originCustomHeaders } from "./config.js";

/**
 * Sentinel meaning "hand the request back to CloudFront untouched".
 *
 * A frozen object rather than a Symbol so it survives a structured clone and
 * compares by identity in tests.
 */
export const PASSTHROUGH = Object.freeze({ norgEdge: "passthrough" });

/**
 * The hostname the visitor actually asked for.
 *
 * Read from the Host header as the customer's own origin request policy
 * delivers it. Must be read BEFORE the pipeline runs: switchOriginToNorg
 * replaces this header on its way out.
 *
 * Returns null for anything that is not a bare hostname, so a malformed Host
 * is dropped rather than handed to the origin as fact.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @returns {?string} The public hostname, or null when there is none to trust.
 */
export function viewerHost(cfRequest) {
  const host = cfRequest?.headers?.host?.[0]?.value;
  return host && HOSTNAME_PATTERN.test(host) ? host : null;
}

/**
 * The site's public hostname: the viewer's, or the one configured at install.
 *
 * The viewer's Host is used when it names something other than the origin. A
 * customer origin request policy that does not forward the viewer's Host
 * delivers the origin's own name instead, and then the hostname content-craft
 * wrote into the install config (`x-norg-site-host`, the site's domain) is the
 * only source of the public name. Without it the router's page reads went
 * straight to the origin and timed out against an origin that accepts only
 * CloudFront, and X-Norg-Public-Host named the origin (0.6.6 and earlier).
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {?string} configuredHost SITE_HOST from the install config.
 * @returns {?string} The public hostname, or null when there is none to trust.
 */
export function publicHostFor(cfRequest, configuredHost) {
  const viewer = viewerHost(cfRequest);
  if (viewer && viewer !== cfRequest?.origin?.custom?.domainName) return viewer;
  if (configuredHost && HOSTNAME_PATTERN.test(configuredHost)) return configuredHost;
  return viewer;
}

/**
 * Tell the origin which public hostname this request arrived on.
 *
 * Always authoritative: the header is SET from the viewer's real Host, or
 * DELETED when there is none to trust. A viewer's own copy is never forwarded,
 * or anyone could make the origin advertise a sitemap full of foreign URLs.
 *
 * @param {Object} cfRequest CloudFront request object, mutated in place.
 * @param {?string} publicHost Hostname from viewerHost, read before the pipeline.
 * @returns {void}
 */
function setPublicHost(cfRequest, publicHost) {
  if (!cfRequest.headers) return;
  if (publicHost) {
    cfRequest.headers[PUBLIC_HOST_HEADER] = [{ key: "X-Norg-Public-Host", value: publicHost }];
  } else {
    delete cfRequest.headers[PUBLIC_HOST_HEADER];
  }
}

/**
 * Absolute URL of the customer's origin for this request.
 *
 * CloudFront's origin config carries the real hostname, protocol, port and an
 * optional path prefix; the request's own Host header is the customer's public
 * domain and may not resolve to the origin at all.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @returns {?string} Absolute origin URL, or null for a non-custom origin.
 */
export function originUrl(cfRequest) {
  const custom = cfRequest.origin?.custom;
  if (!custom) return null;

  const protocol = custom.protocol === "http" ? "http" : "https";
  const defaultPort = protocol === "https" ? 443 : 80;
  const port = custom.port && custom.port !== defaultPort ? `:${custom.port}` : "";
  const prefix = custom.path || "";
  const query = cfRequest.querystring ? `?${cfRequest.querystring}` : "";

  return `${protocol}://${custom.domainName}${port}${prefix}${cfRequest.uri}${query}`;
}

/**
 * Budget for a read of the customer's page made by the router itself.
 *
 * Shorter than the mirror fetch on purpose: a read that cannot complete must
 * cost the agent well under the few seconds AI fetchers wait, because every
 * caller's fallback (ordinary passthrough) still has to run after it.
 */
export const ORIGIN_READ_TIMEOUT_MS = 3000;

/**
 * Where the router reads the customer's page from, and whether that is the
 * customer's own CloudFront distribution.
 *
 * Through the distribution's public hostname whenever the viewer's Host names
 * one: CloudFront then fetches the origin exactly as it does for a visitor, so
 * the read works however the origin is locked down. Bloom Healthcare's origin
 * accepts only CloudFront; a direct read from the function timed out on every
 * agent request (4-9 seconds), and AI fetchers gave up first (2026-10-15). The
 * loop guard the read carries makes the router pass that request straight on.
 * When the Host names the origin itself (a policy that does not forward the
 * viewer's Host), the public name comes from the install config; only when
 * neither is available is the origin read directly.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {?string} configuredHost SITE_HOST from the install config, used when
 *   the Host names the origin (see publicHostFor).
 * @returns {?{url: string, viaDistribution: boolean}} Target, or null.
 */
export function originReadTarget(cfRequest, configuredHost) {
  const direct = originUrl(cfRequest);
  if (!direct) return null;
  const publicHost = publicHostFor(cfRequest, configuredHost);
  if (!publicHost || publicHost === cfRequest.origin?.custom?.domainName) {
    return { url: direct, viaDistribution: false };
  }
  // Drop the ?agent= force-serve override. The loop guard already passes this
  // read straight on, but a customer origin request policy that does not
  // forward our header would hide the guard from the router; without the
  // override the read, which comes from an AWS address rather than an AI
  // provider's, can never be routed down the agent path again.
  const params = new URLSearchParams(cfRequest.querystring || "");
  params.delete("agent");
  const query = params.toString() ? `?${params.toString()}` : "";
  return { url: `https://${publicHost}${cfRequest.uri}${query}`, viaDistribution: true };
}

/**
 * Read the customer's page, for the branches that must see its bytes.
 *
 * Carries the viewer's own headers so the page is the one the visitor would
 * have got, plus the loop guard. On a direct read it also carries the origin's
 * OWN custom headers — the ones CloudFront would have attached, minus NORG's,
 * which readConfig has already removed — because an origin behind a
 * verification header (an ALB that 403s without `x-origin-verify`) answers a
 * read without them with that 403. A read through the distribution must NOT
 * carry them: CloudFront adds them itself, and a customer's secret has no
 * business on the public path. Returns null rather than throwing, because
 * every caller's answer to a failed read is the same: fall back to ordinary
 * passthrough and let CloudFront try.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view of the same call.
 * @param {number} timeoutMs Budget for the fetch.
 * @param {?string} configuredHost SITE_HOST from the install config.
 * @returns {Promise<?Response>} Origin response, or null on any failure.
 */
export async function fetchOrigin(cfRequest, request, timeoutMs, configuredHost) {
  const target = originReadTarget(cfRequest, configuredHost);
  if (!target) return null;

  const headers = new Headers(request.headers);
  if (!target.viaDistribution) {
    for (const [name, entries] of Object.entries(originCustomHeaders(cfRequest) || {})) {
      if (entries?.[0]?.value !== undefined) headers.set(name, entries[0].value);
    }
  }
  headers.set(LOOP_GUARD_HEADER, "1");
  // fetch sets Host from the target URL: the public name through the
  // distribution, the origin's own name on a direct read. A viewer's Host left
  // on a direct read to a different host is what breaks virtual-hosted origins.
  headers.delete("host");
  // The read is re-served to the caller, so absolute URLs in it must name the
  // site the visitor is on. Set or dropped, never relayed from the viewer.
  const publicHost = publicHostFor(cfRequest, configuredHost);
  if (publicHost) headers.set(PUBLIC_HOST_HEADER, publicHost);
  else headers.delete(PUBLIC_HOST_HEADER);
  // The body is read and re-served by this function, so it must arrive as
  // bytes the strip can read: fetch would decode a compressed body but leave
  // the content-encoding header behind.
  headers.set("accept-encoding", "identity");

  try {
    return await fetch(target.url, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    console.error("norg edge origin fetch failed", target.viaDistribution ? "(via distribution)" : "(direct)", e);
    return null;
  }
}

/**
 * Hand a request on to the origin with its Host header exactly as delivered.
 *
 * The Host the origin receives is the customer's own distribution's decision,
 * not ours: an origin request policy that forwards the viewer's Host delivers
 * the public hostname, one that does not delivers the origin's own name. The
 * router used to overwrite it with `origin.custom.domainName` on every exit
 * (0.6.1 to 0.6.4). That broke every origin that is reached under the public
 * hostname: a WordPress staging site on EC2 saw its own EC2 name, redirected
 * the homepage to itself in a loop and sent slash-less URLs to the unreachable
 * EC2 hostname (2026-10-15, the first customer CloudFront install).
 *
 * Overwriting was believed to be a CloudFront requirement. It is not: on a
 * test distribution (E2YX4EGQFD2LKC, origin httpbin.org, managed AllViewer
 * policy, 2026-10-15) an origin-request function that returned the request
 * untouched delivered the viewer's Host to the origin with a 200, and the same
 * function rewriting Host delivered the origin's. The blanket 403 behind the
 * old rule was the origin looping, not CloudFront refusing: a Cloudflare-fronted
 * origin was sent a viewer Host its own setup never forwarded, and proxied it
 * straight back into CloudFront. The install now keeps the customer's origin
 * request policy, so an untouched Host is what that origin always received.
 *
 * Two paths still set Host themselves, because they change WHERE the request
 * goes: switchOriginToNorg (the receptionist) and fetchOrigin (a direct read).
 *
 * The public hostname still travels in PUBLIC_HOST_HEADER, so an origin that is
 * reached under its own name can build absolute URLs from the one the visitor
 * typed.
 *
 * @param {Object} cfRequest CloudFront request object, mutated in place.
 * @param {?string} publicHost Hostname from viewerHost, read before the pipeline
 *   could mutate the Host header.
 * @returns {Object} The same request object.
 */
export function toOrigin(cfRequest, publicHost) {
  setPublicHost(cfRequest, publicHost);
  return cfRequest;
}

/**
 * Repoint this request at NORG's edge-content receptionist.
 *
 * Used for a mirror too large to return as a generated response. CloudFront
 * then fetches the mirror as if it were the origin — streamed, uncapped, and
 * without the body passing through Lambda at all.
 *
 * The receptionist is responsible for the response headers in this path
 * (X-Norg-Edge, X-Norg-Edge-Env and the no-store directives), because nothing
 * runs after this to add them. That is a real coupling, and it is why this is
 * the fallback rather than the default.
 *
 * @param {Object} cfRequest CloudFront request object, mutated in place.
 * @param {string} contentStemUrl Receptionist base including the site id.
 * @param {string} keySuffix Mirror key suffix from pathToKeySuffix.
 * @param {Object} authHeaders Site id/key headers authenticating the read.
 * @returns {Object} The PASSTHROUGH sentinel.
 */
export function switchOriginToNorg(cfRequest, contentStemUrl, keySuffix, authHeaders) {
  const stem = new URL(contentStemUrl);
  const customHeaders = {};
  for (const [key, value] of Object.entries(authHeaders)) {
    customHeaders[key.toLowerCase()] = [{ key, value }];
  }
  customHeaders[LOOP_GUARD_HEADER] = [{ key: LOOP_GUARD_HEADER, value: "1" }];

  cfRequest.origin = {
    custom: {
      domainName: stem.hostname,
      port: stem.protocol === "http:" ? 80 : 443,
      protocol: stem.protocol === "http:" ? "http" : "https",
      path: "",
      sslProtocols: ["TLSv1.2"],
      readTimeout: 30,
      keepaliveTimeout: 5,
      customHeaders,
    },
  };
  // CloudFront routes on the Host header for a custom origin, so it has to name
  // the receptionist rather than the customer's domain.
  cfRequest.headers.host = [{ key: "Host", value: stem.hostname }];
  cfRequest.uri = `${stem.pathname.replace(/\/+$/, "")}${keySuffix}`;
  cfRequest.querystring = "";

  return PASSTHROUGH;
}
