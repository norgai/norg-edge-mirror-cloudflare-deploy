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
 * Fetch the customer's origin directly, for the branches that must read it.
 *
 * Carries the viewer's own headers so the origin sees the request it would have
 * seen anyway, plus the origin's OWN custom headers — the ones CloudFront would
 * have attached, minus NORG's, which readConfig has already removed. An origin
 * behind a verification header (an ALB that 403s without `x-origin-verify`)
 * used to answer every direct read with that 403, and the agent got it. Plus
 * the loop guard. Returns null rather than throwing, because every caller's
 * answer to a failed origin read is the same: fall back to ordinary
 * passthrough and let CloudFront try.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view of the same call.
 * @param {number} timeoutMs Budget for the fetch.
 * @returns {Promise<?Response>} Origin response, or null on any failure.
 */
export async function fetchOrigin(cfRequest, request, timeoutMs) {
  const target = originUrl(cfRequest);
  if (!target) return null;

  const headers = new Headers(request.headers);
  for (const [name, entries] of Object.entries(originCustomHeaders(cfRequest) || {})) {
    if (entries?.[0]?.value !== undefined) headers.set(name, entries[0].value);
  }
  headers.set(LOOP_GUARD_HEADER, "1");
  // The origin is addressed by its own hostname; leaving the viewer's Host
  // header on a fetch to a different host is what breaks virtual-hosted origins.
  headers.delete("host");
  // Which is exactly why the public host has to travel separately: this read is
  // re-served to the caller, so absolute URLs in it must name the site the
  // visitor is on. Set or dropped, never relayed from the viewer.
  const publicHost = viewerHost(cfRequest);
  if (publicHost) headers.set(PUBLIC_HOST_HEADER, publicHost);
  else headers.delete(PUBLIC_HOST_HEADER);
  // The body is read and re-served by this function, so it must arrive as
  // bytes the strip can read: fetch would decode a compressed body but leave
  // the content-encoding header behind.
  headers.set("accept-encoding", "identity");

  try {
    return await fetch(target, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    console.error("norg edge origin fetch failed", e);
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
