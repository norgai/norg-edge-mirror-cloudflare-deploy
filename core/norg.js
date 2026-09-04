/**
 * Reading NORG-rendered objects, and shaping the responses built from them.
 *
 * @description Receptionist client plus the response headers each surface sets.
 *
 * The mirror bucket is never public: everything is read through the
 * edge-content receptionist, an authenticated NORG-account service, and the
 * site id/key headers are what authorise the read. There is deliberately no
 * content-prefix or bucket binding anywhere in this artifact — NORG resolves
 * which content belongs to this site server-side, so a misconfigured install
 * cannot read another site's content.
 *
 * The header sets below are the visible contract with the outside world, and
 * they divide into two kinds:
 *
 *  - Tenant content (a mirror, a stripped page) is `private, no-store` on both
 *    Cache-Control and CDN-Cache-Control. `Vary: User-Agent` is deliberately
 *    NOT used: it is advisory, and CDNs variously normalise, collapse or ignore
 *    it, which is the exact failure — a shopper served a spec sheet — that
 *    no-store replaces.
 *  - Shared assets (theme CSS, the OpenAI feeds) are identical for every caller
 *    and so are publicly cacheable.
 */

import {
  LOOP_GUARD_HEADER,
  MIRROR_FETCH_TIMEOUT_MS,
  RESERVED_ASSET_CACHE_CONTROL,
} from "./constants.mjs";
import { binding, contentStem, controlHeaders, edgeEnv } from "./config.js";

/**
 * Fetch a NORG-rendered object for this path from the edge-content
 * receptionist.
 *
 * One round trip: a 200 is the render and a 404 is a definite miss — there is
 * no separate existence check. The 404/error distinction is load-bearing: only
 * a definite 404 may trigger a render request, because reporting timeouts would
 * let an outage look like every page vanishing and NORG would re-render the
 * whole site.
 *
 * @param {Object} env Install config.
 * @param {string} keySuffix Key suffix from pathToKeySuffix.
 * @returns {Promise<{response: ?Response, missing: boolean}>} missing is true
 *   only for a definite 404, never for an error or timeout.
 */
export async function fetchFromNorg(env, keySuffix) {
  const target = `${contentStem(env)}${keySuffix}`;
  try {
    const response = await fetch(target, {
      headers: { ...controlHeaders(env), [LOOP_GUARD_HEADER]: "1" },
      signal: AbortSignal.timeout(MIRROR_FETCH_TIMEOUT_MS),
    });

    if (response.status === 404) return { response: null, missing: true };
    if (!response.ok) return { response: null, missing: false };
    return { response, missing: false };
  } catch (e) {
    console.error("norg edge mirror fetch failed", e);
    return { response: null, missing: false };
  }
}

/**
 * Headers authorising a receptionist read, for the origin-switch path.
 *
 * @param {Object} env Install config.
 * @returns {Object} Site id/key/version headers.
 */
export function receptionistHeaders(env) {
  const { "Content-Type": _contentType, ...auth } = controlHeaders(env);
  return auth;
}

/**
 * Forbid every cache — browser, proxy, and CDN — from storing a response.
 *
 * @param {Headers} headers Response headers to mutate in place.
 * @returns {void}
 */
export function setNonCacheable(headers) {
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "private, no-store");
}

/**
 * Serve a NORG render at the customer's URL.
 *
 * Deliberately not noindex: this IS the customer's page as far as an agent is
 * concerned, and it carries a canonical link to this same URL.
 *
 * @param {Response} norgResponse Response from the receptionist.
 * @param {Object} env Install config.
 * @returns {Response} Response for the visitor.
 */
export function mirrorResponse(norgResponse, env) {
  const headers = new Headers();
  // Trust what the bucket stored; renders are HTML but the namespace can hold
  // other types.
  headers.set(
    "Content-Type",
    norgResponse.headers.get("content-type") || "text/html; charset=utf-8",
  );
  headers.set("X-Norg-Edge", "mirror");
  setNonCacheable(headers);
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(norgResponse.body, { status: 200, headers });
}

/**
 * Serve a reserved NORG asset (e.g. /.norg/theme.css).
 *
 * A shared asset, not tenant content, so it takes public cache headers rather
 * than mirrorResponse's private/no-store.
 *
 * @param {Response} norgResponse Response from the receptionist.
 * @param {Object} env Install config.
 * @returns {Response} Response for the visitor.
 */
export function reservedAssetResponse(norgResponse, env) {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    norgResponse.headers.get("content-type") || "text/css; charset=utf-8",
  );
  headers.set("Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("CDN-Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("X-Norg-Edge", "reserved-asset");
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(norgResponse.body, { status: 200, headers });
}

/**
 * Serve a site-level OpenAI feed artifact.
 *
 * @param {Response} norgResponse Response from the receptionist.
 * @param {Object} env Install config.
 * @param {string} pathname Request pathname, which selects the content type.
 * @returns {Response} Response for the visitor.
 */
export function openAiFeedResponse(norgResponse, env, pathname) {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    pathname.endsWith(".yaml") ? "application/yaml" : "application/json; charset=utf-8",
  );
  headers.set("Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("CDN-Cache-Control", RESERVED_ASSET_CACHE_CONTROL);
  headers.set("X-Norg-Edge", "openai-feed");
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(norgResponse.body, { status: 200, headers });
}

/**
 * Serve an MCP descriptor.
 *
 * @param {Response} norgResponse Response from the receptionist.
 * @returns {Response} Response for the visitor.
 */
export function mcpResponse(norgResponse) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("X-Norg-Edge", "mcp");
  return new Response(norgResponse.body, { status: 200, headers });
}

/**
 * Serve the origin, stripped to a token-dense form.
 *
 * @param {string} html Stripped HTML.
 * @param {number} status Status of the origin response it came from.
 * @param {Object} env Install config.
 * @returns {Response} Response for the agent.
 */
export function strippedResponse(html, status, env) {
  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Norg-Edge", "stripped");
  // A stripped response is diverted too — never cacheable. It is superseded as
  // soon as the render we just requested lands.
  setNonCacheable(headers);
  headers.set("X-Norg-Edge-Env", edgeEnv(env));
  return new Response(html, { status, headers });
}

/**
 * Answer an authenticated health probe.
 *
 * @param {Object} env Install config.
 * @param {boolean} entitled Whether this container holds an authenticated feed.
 * @returns {Response} JSON status.
 */
export function healthResponse(env, entitled) {
  return new Response(
    JSON.stringify({
      site_id: env.SITE_ID || null,
      version: env.EDGE_SCRIPT_VERSION || "unknown",
      env: edgeEnv(env),
      disabled: binding(env, "EDGE_DISABLED") === "true",
      platform: env.EDGE_PLATFORM || "unknown",
      // Whether this container currently holds an authenticated feed. The first
      // question to ask when an install is "doing nothing" — an unentitled
      // router passes everything through and is otherwise indistinguishable
      // from not being installed at all.
      entitled,
      ts: Date.now(),
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Not in the Cloudflare worker, and needed here: CloudFront applies its
        // cache policy's default TTL to a 200 that says nothing, so a probe
        // answer would be cached and later probes would read a stale `ts` and
        // `entitled` — the two fields the probe exists to report.
        "Cache-Control": "private, no-store",
      },
    },
  );
}
