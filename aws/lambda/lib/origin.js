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
 * Read from the viewer's own Host header, which the install's origin-request
 * policy forwards verbatim (`allViewerAndWhitelistCloudFront`). Must be read
 * BEFORE the pipeline runs: alignHostToOrigin and switchOriginToNorg both
 * replace this header on their way out.
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
 * Point the Host header at the origin this request is bound for.
 *
 * THIS IS A PLATFORM REQUIREMENT, NOT A CHOICE. When an origin-request function
 * returns a request for a custom origin, CloudFront requires the Host header to
 * match `request.origin.custom.domainName`. A mismatch is rejected before the
 * origin is contacted: the viewer gets a CloudFront 403 "Bad request" and
 * NOTHING is written to the function's log, because the function did not fail —
 * its output was refused. AWS's own origin-modification helpers set Host to the
 * origin domain for exactly this reason.
 *
 * DO NOT make this conditional to "preserve the viewer's Host". That was tried,
 * shipped, and took the site down with a blanket 403 within minutes. The
 * motivation was real — see the consequence below — but this is not where it
 * can be fixed.
 *
 * The consequence, which is a property of putting Lambda@Edge on origin-request
 * at all: the origin always sees ITS OWN hostname, never the one the visitor
 * typed. A host-aware origin therefore builds absolute URLs, canonical tags,
 * cookie domains and auth redirects from the origin's name. An auth layer that
 * redirects to its own host will bounce visitors off the CloudFront domain.
 * The fix for that lives at the origin (serve the CloudFront-facing hostname
 * directly, or stop emitting host-absolute redirects), not here.
 *
 * Reading the value from origin.custom.domainName keeps it correct after an
 * origin switch too: switchOriginToNorg has already repointed that field at the
 * receptionist by the time this runs.
 *
 * What CAN be fixed here is the origin's BLINDNESS to the public name: the
 * viewer's host is forwarded alongside, in PUBLIC_HOST_HEADER, so a host-aware
 * origin can build its absolute URLs from the name the visitor typed while the
 * Host header keeps CloudFront happy. That is the supported half of the fix,
 * and the sitemap the mirror serves depends on it.
 *
 * @param {Object} cfRequest CloudFront request object, mutated in place.
 * @param {?string} publicHost Hostname from viewerHost, read before the pipeline
 *   mutated the Host header.
 * @returns {Object} The same request object.
 */
export function alignHostToOrigin(cfRequest, publicHost) {
  setPublicHost(cfRequest, publicHost);
  const domainName = cfRequest.origin?.custom?.domainName;
  if (domainName) cfRequest.headers.host = [{ key: "Host", value: domainName }];
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
