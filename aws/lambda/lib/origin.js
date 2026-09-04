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

import { LOOP_GUARD_HEADER } from "./constants.mjs";

/**
 * Sentinel meaning "hand the request back to CloudFront untouched".
 *
 * A frozen object rather than a Symbol so it survives a structured clone and
 * compares by identity in tests.
 */
export const PASSTHROUGH = Object.freeze({ norgEdge: "passthrough" });

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
 * seen anyway, plus the loop guard. Returns null rather than throwing, because
 * every caller's answer to a failed origin read is the same: fall back to
 * ordinary passthrough and let CloudFront try.
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
  headers.set(LOOP_GUARD_HEADER, "1");
  // The origin is addressed by its own hostname; leaving the viewer's Host
  // header on a fetch to a different host is what breaks virtual-hosted origins.
  headers.delete("host");

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
