/**
 * NORG.ai Content-Craft Platform — Edge Router (Bunny Edge Scripting)
 *
 * @description The request pipeline. Imports no Bunny SDK module, so it runs
 * under `node --test` with nothing installed — index.js is the only file that
 * touches the platform SDK.
 */

/*
 * The Bunny port of workers/edge-router-worker.js. The pipeline in
 * handleRequest is the same pipeline, in the same order, and the three rules
 * that govern the Cloudflare worker govern this file too:
 *
 *  1. THIS MUST NEVER BREAK THE CUSTOMER'S SITE. Every failure path ends at
 *     the origin. Here that is close to free: "serve the origin" is a sentinel
 *     the entry point turns back into `ctx.request`, and Bunny's own origin
 *     machinery does the fetch — so a thrown error costs the visitor nothing
 *     beyond the script's own runtime.
 *  2. SEARCH ENGINES ARE NOT AI AGENTS. Googlebot and friends always get the
 *     origin. There is no flag to turn this off, and nothing overrides it —
 *     not even ?agent=true.
 *  3. NOTHING HAPPENS WITHOUT AN AUTHENTICATED FEED. SITE_ID + NORG_SITE_KEY
 *     are compulsory, and until one NORG call succeeds the router changes
 *     nothing at all. There is no local pattern list to fall back on.
 *
 * WHY THIS PORT IS SHORT. Everything below the adapters is shared with the
 * other providers and imported unchanged from core/: classification and the
 * three gates, the feed and the entitlement gate, the strip tokenizer, the
 * path predicates, telemetry, constants. Bunny runs Deno 2.7 with a real
 * `fetch`, real `Request`/`Response`, `AbortSignal.timeout` and
 * `Bunny.v1.waitUntil`, so it needs only three adapters — config (environment
 * variables + secrets), request (client IP and the visitor-facing URL) and
 * origin (the passthrough sentinel).
 *
 * THE SAME THREE CHOICES AS EVERY 0.6.0 ADAPTER:
 *  - Humans never wait on NORG. An ordinary browser, a search crawler and a
 *    static asset leave before the feed is read (core/fastpath.js).
 *  - The router makes no call of its own to report a visit. The visit rides
 *    as one header on the mirror fetch it awaits anyway (core/visit.js), and
 *    NORG's content service records it — and, on a miss, enqueues the render.
 *  - The human page is never cached at the edge, so every page request
 *    reaches the router. On Bunny that is an install-time property of the
 *    pull zone rather than of this code — see the README, "The cache is the
 *    hazard".
 *
 * WHAT BUNNY GIVES US THAT CLOUDFRONT DID NOT:
 *  - A real `waitUntil` (`env.EDGE_KEEPALIVE`), so the opt-in passthrough
 *    event and a stale feed's refresh run behind the response.
 *  - No generated-response cap, so a mirror is always returned inline WITH its
 *    X-Norg-Edge headers — no origin-switch fallback.
 *  - Write-only secrets for NORG_SITE_KEY.
 *  - Passthrough is the platform's own origin fetch, so the Host header, the
 *    retry policy and the origin shield are all Bunny's problem, not ours.
 *
 * WHAT IT STILL LACKS:
 *  - Cron. The 30-minute liveness beat must be driven by NORG pinging the
 *    install, exactly as on Fastly and CloudFront.
 *  - A verified-bot signal. Source verification is CIDR-only (see lib/request).
 *  - Before-cache execution. `onOriginRequest` runs on a cache MISS only, so
 *    the install keeps HTML out of the pull zone's cache.
 */

import { withAlternateFormatHeaders } from "../../workers/lib/alternate-format.mjs";
import { isAgenticPath, pathToKeySuffix } from "../../workers/lib/r2-content.mjs";
import { mcpForwardHeaders } from "../../workers/lib/mcp-forward.mjs";

import {
  HEALTH_CHECK_HEADER,
  LOOP_GUARD_HEADER,
  MCP_FORWARD_TIMEOUT_MS,
  MIRROR_FETCH_TIMEOUT_MS,
  STRIP_WORD_FLOOR,
} from "../../core/constants.mjs";
import { binding } from "../../core/config.js";
import {
  agentOverrideClassification,
  anonymousClassification,
  classifyAgent,
  mayDivert,
  verifiedSource,
} from "../../core/agent.js";
import { fastPathExit } from "../../core/fastpath.js";
import { getBotFeed, isEntitled } from "../../core/feed.js";
import {
  fetchFromNorg,
  healthResponse,
  mcpResponse,
  mirrorResponse,
  openAiFeedResponse,
  reservedAssetResponse,
  strippedResponse,
} from "../../core/norg.js";
import {
  hasAgentOverride,
  isDiscoveryPath,
  isMcpPath,
  isNorgOwnedArtifactPath,
  isOpenAiFeedPath,
  isReservedNorgPath,
  isSiblingArtifactPath,
  isSkippedPath,
  isStaticAssetPath,
  isTraditionalSearchBot,
  siblingPageOf,
} from "../../core/paths.js";
import { countVisibleWords, stripHtml } from "../../core/strip.js";
import { reportPassthrough } from "../../core/telemetry.js";
import { visitHeader } from "../../core/visit.js";

import { EDGE_SCRIPT_VERSION } from "./lib/config.js";
import { PASSTHROUGH, fetchOrigin } from "./lib/origin.js";
import { clientIp, visitorUrl } from "./lib/request.js";

/**
 * A view of the request carrying the URL the VISITOR asked for.
 *
 * Bunny points `ctx.request.url` at the origin before the hook runs, so every
 * core function that reads `request.url` — the visit event's `domain`, the
 * canonical Link headers, the render request — would otherwise record the
 * origin hostname instead of the customer's. The body is deliberately not
 * carried: no caller of this view reads one (the MCP forward reads the
 * original request instead).
 *
 * @param {Request} originRequest Origin-pointed request from the hook.
 * @param {URL} url Visitor-facing URL.
 * @returns {Request} Request view addressed at the visitor's URL.
 */
function toVisitorRequest(originRequest, url) {
  return new Request(url.toString(), {
    method: originRequest.method === "HEAD" ? "GET" : originRequest.method,
    headers: originRequest.headers,
  });
}

/**
 * Is this an authenticated health probe rather than a real visit?
 *
 * The key comparison is not constant-time. A successful probe reveals only the
 * site id and script version, both of which the operator running the probe
 * already knows.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @returns {boolean} True when the probe key matches.
 */
function isHealthProbe(request, env) {
  const probeKey = request.headers.get(HEALTH_CHECK_HEADER);
  return Boolean(probeKey && env.NORG_SITE_KEY && probeKey === env.NORG_SITE_KEY);
}

/**
 * Should this request skip interception entirely?
 *
 * @param {Request} request Incoming request.
 * @param {URL} url Visitor-facing URL.
 * @param {Object} env Install config.
 * @returns {boolean} True to pass straight to origin.
 */
function isPassthrough(request, url, env) {
  if (binding(env, "EDGE_DISABLED") === "true") return true;
  if (request.headers.get(LOOP_GUARD_HEADER)) return true;
  if (request.headers.get("upgrade")) return true;

  const method = request.method;
  if (method === "GET") return false;
  // HEAD must answer with the SAME status and headers as GET (RFC 9110), and
  // these paths exist only in NORG's bucket — passing HEAD to the origin would
  // 404 every one of them while GET returned 200.
  if (method === "HEAD" && isNorgOwnedArtifactPath(url.pathname)) return false;
  // MCP is the one surface that accepts POST (JSON-RPC transport).
  if (method === "POST" && isMcpPath(url.pathname)) return false;
  return true;
}

/**
 * Serve a NORG-published artifact origin-first.
 *
 * A 200 with a non-HTML content type is the customer's own file and wins. A
 * 404/error, or an HTML 200 (a SPA soft-404, not a real artifact), means the
 * origin has none, so the NORG copy is served. On a receptionist miss the
 * request falls through to ordinary passthrough.
 *
 * @param {Request} originRequest Origin-pointed request.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @param {boolean} alternateFormatHeaders Apply canonical Link + noindex.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveOriginFirstArtifact(originRequest, env, url, alternateFormatHeaders) {
  const origin = await fetchOrigin(originRequest, MIRROR_FETCH_TIMEOUT_MS);
  if (origin && origin.status === 200) {
    const contentType = origin.headers.get("content-type") || "";
    // A real llms.txt/tree.json is never HTML; an HTML 200 is a SPA soft-404.
    if (!/text\/html/i.test(contentType)) return origin;
  }

  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  // Never the origin's own error from here: Bunny's passthrough carries what
  // the origin expects, this function's read may not.
  if (!response) return PASSTHROUGH;

  const served = mirrorResponse(response, env);
  return alternateFormatHeaders ? withAlternateFormatHeaders(served, url, url.pathname) : served;
}

/**
 * The headers that let the receptionist record this visit and act on a miss.
 *
 * @param {Request} request Visitor-facing request view.
 * @param {Object} env Install config.
 * @param {Object} classification Bot classification.
 * @param {string} served Label on a hit.
 * @param {string} servedOnMiss Label on a miss.
 * @param {boolean} lazyRender Whether a miss should enqueue a render.
 * @returns {Object} Extra headers for fetchFromNorg.
 */
function visitHeaders(request, env, classification, served, servedOnMiss, lazyRender) {
  const headers = { "X-Norg-Visit": visitHeader(request, classification, served, servedOnMiss) };
  if (lazyRender && binding(env, "LAZY_RENDER_ENABLED") !== "false") {
    headers["X-Norg-Lazy-Render"] = "1";
  }
  return headers;
}

/**
 * What the router will serve if the receptionist has no mirror for an agent.
 *
 * @param {Object} env Install config.
 * @returns {string} "stripped" or "origin".
 */
function missIntent(env) {
  return binding(env, "STRIP_FALLBACK_ENABLED") === "false" ? "origin" : "stripped";
}

/**
 * Forward an MCP JSON-RPC request to NORG's public MCP endpoint.
 *
 * Returns NORG's response ONLY when NORG can serve the request; otherwise null
 * so the caller falls back to the customer origin (rule 1). HTTP 2xx is
 * returned as-is, because a JSON-RPC application error arrives as HTTP 200 and
 * IS the caller's answer.
 *
 * Only the headers JSON-RPC needs are relayed (workers/lib/mcp-forward.mjs), so
 * a Cookie or Authorization header sent to the customer's domain never reaches
 * NORG.
 *
 * @param {Request} originRequest Origin-pointed request, carrying the body.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @returns {Promise<?Response>} NORG's 2xx response, or null on any miss.
 */
async function forwardMcpToNorg(originRequest, env, url) {
  try {
    const headers = mcpForwardHeaders(originRequest.headers);
    headers.set("X-Norg-Site-Id", env.SITE_ID || "");
    headers.set("X-Norg-Site-Key", env.NORG_SITE_KEY || "");
    headers.set("X-Norg-Edge-Page", url.pathname);
    headers.set("X-Norg-Edge-Version", EDGE_SCRIPT_VERSION);

    // The trailing slash is load-bearing: the mount's streamable-HTTP route is
    // at "/", so "/public-mcp" answers 307 — and this POST's body cannot be
    // replayed onto the redirect.
    const response = await fetch(`${binding(env, "NORG_API_URL")}/public-mcp/`, {
      method: "POST",
      headers,
      body: await originRequest.arrayBuffer(),
      signal: AbortSignal.timeout(MCP_FORWARD_TIMEOUT_MS),
    });
    return response.ok ? response : null;
  } catch (e) {
    console.error("norg edge mcp forward failed", e);
    return null;
  }
}

/**
 * Serve the MCP surface for a page.
 *
 * GET reads the static artifact published alongside the render. POST is the
 * JSON-RPC transport and is forwarded to NORG. A miss falls through to the
 * origin for GET and POST alike, so a customer's own /mcp route keeps working.
 *
 * @param {Request} originRequest Origin-pointed request.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @returns {Promise<?Response>} Response, or null to fall through to origin.
 */
async function handleMcp(originRequest, env, url) {
  if (originRequest.method === "POST") return forwardMcpToNorg(originRequest, env, url);
  if (originRequest.method !== "GET" && originRequest.method !== "HEAD") return null;

  // "/products/x/mcp" -> "/products/x/mcp.json"; "/mcp" -> "/mcp.json".
  const suffix =
    url.pathname === "/.well-known/mcp.json"
      ? "/.well-known/mcp.json"
      : `${url.pathname.replace(/\/(mcp|sse)$/, "")}/mcp.json`;

  const { response } = await fetchFromNorg(env, suffix);
  return response ? mcpResponse(response) : null;
}

/**
 * Serve an AI agent: the NORG render if it exists, else the stripped origin.
 *
 * One NORG call, which the visitor was always going to wait for. The visit
 * header on it is how the event is recorded and how a miss enqueues a render;
 * neither is a call of this function's own. A thin strip is reported as
 * "stripped" by the receptionist because the decision is made after it
 * answered — `origin_thin` and the word count are not distinguished on this
 * provider. No size branch, unlike CloudFront: Bunny imposes no cap on a
 * generated response.
 *
 * @param {Request} originRequest Origin-pointed request.
 * @param {Request} request Visitor-facing request view.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @param {Object} classification Bot classification.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveAgent(originRequest, request, env, url, classification) {
  const headers = visitHeaders(request, env, classification, "mirror", missIntent(env), true);
  const { response, refused } = await fetchFromNorg(env, pathToKeySuffix(url.pathname), headers);
  if (response) return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
  // A refused install changes nothing, this request included: no strip.
  if (refused) return PASSTHROUGH;
  return serveStrippedOrigin(originRequest, env);
}

/**
 * Serve the origin, stripped to a token-dense form where possible.
 *
 * If the strip leaves fewer than STRIP_WORD_FLOOR visible words — a
 * client-rendered origin whose real content the strip removes — the stripped
 * page carries less than the origin, so the origin is served untouched. Any
 * origin answer that is not a 200 HTML page is served by passthrough as well,
 * never relayed from here: Bunny's own origin fetch carries what the origin
 * expects, and this function's read may not.
 *
 * @param {Request} originRequest Origin-pointed request.
 * @param {Object} env Install config.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveStrippedOrigin(originRequest, env) {
  if (binding(env, "STRIP_FALLBACK_ENABLED") === "false") return PASSTHROUGH;

  const origin = await fetchOrigin(originRequest, MIRROR_FETCH_TIMEOUT_MS);
  if (!origin) return PASSTHROUGH;

  const contentType = origin.headers.get("content-type") || "";
  if (origin.status !== 200 || !/text\/html/i.test(contentType)) return PASSTHROUGH;

  // Buffering is safe here: 128 MB of active memory, and the word floor cannot
  // be applied without measuring the result first.
  const html = await origin.text();
  const stripped = stripHtml(html);
  if (countVisibleWords(stripped) < STRIP_WORD_FLOOR) return PASSTHROUGH;

  return strippedResponse(stripped, origin.status, env);
}

/**
 * Serve the agentic subtree from the NORG render.
 *
 * Addressed by URL, not by caller: every visitor asking for this path gets the
 * same bytes, so there is no classification, no source-IP verification and no
 * cloaking question to answer. A miss is a passthrough, never a synthesised
 * 404, and no render is enqueued.
 *
 * @param {Request} request Visitor-facing request view.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @param {string} prefix Configured agentic prefix.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveAgenticPath(request, env, url, prefix) {
  const innerPath = url.pathname.slice(prefix.length) || "/";
  const headers = visitHeaders(
    request, env, anonymousClassification(), "agentic_path", "agentic_path_miss", false,
  );
  const { response } = await fetchFromNorg(env, pathToKeySuffix(innerPath), headers);
  if (!response) return PASSTHROUGH;
  return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
}

/**
 * Serve the mirror for a ?agent=true override, bypassing UA/IP classification.
 *
 * Traditional search engines never reach here — the floor runs first — so this
 * cannot cloak. Unlike a genuine bot miss, NO render is enqueued: param-driven
 * demo/QA traffic must not trigger renders across the catalogue.
 *
 * @param {Request} request Visitor-facing request view.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveAgentOverride(request, env, url) {
  const headers = visitHeaders(
    request, env, agentOverrideClassification(),
    "agent_param_override", "agent_param_override_miss", false,
  );
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname), headers);
  if (!response) return PASSTHROUGH;
  return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
}

/**
 * The NORG-owned surfaces, served before any classification.
 *
 * Each of these is served to every caller from identical bytes, which is
 * exactly why none of them is a cloaking surface.
 *
 * @param {Request} originRequest Origin-pointed request.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @returns {Promise<?(Response|Object)>} Result, or null when none applies.
 */
async function serveNorgOwnedSurface(originRequest, env, url) {
  const pathname = url.pathname;

  if (isMcpPath(pathname)) {
    return (await handleMcp(originRequest, env, url)) || PASSTHROUGH;
  }
  if (isDiscoveryPath(pathname)) {
    return serveOriginFirstArtifact(originRequest, env, url, false);
  }
  if (isReservedNorgPath(pathname)) {
    const { response } = await fetchFromNorg(env, pathToKeySuffix(pathname));
    return response ? reservedAssetResponse(response, env) : PASSTHROUGH;
  }
  if (isOpenAiFeedPath(pathname)) {
    const { response } = await fetchFromNorg(env, pathToKeySuffix(pathname));
    return response ? openAiFeedResponse(response, env, pathname) : PASSTHROUGH;
  }
  return null;
}

/**
 * Classification-gated part of the pipeline, after the search-engine floor.
 *
 * Split out of handleRequest only to keep each function under the size the
 * house style allows; the order of the checks is unchanged.
 *
 * @param {Request} originRequest Origin-pointed request.
 * @param {Request} request Visitor-facing request view.
 * @param {Object} env Install config.
 * @param {URL} url Visitor-facing URL.
 * @param {Object} feed Authenticated feed.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveClassified(originRequest, request, env, url, feed) {
  if (hasAgentOverride(url)) return serveAgentOverride(request, env, url);

  const classification = classifyAgent(request.headers.get("user-agent") || "", feed.patterns);
  if (!classification.is_ai_bot) return PASSTHROUGH;

  // NORG decides which crawlers may be served differently, not this file.
  if (!mayDivert(classification)) return PASSTHROUGH;

  // A spoofable UA is not enough to divert: the source IP must be verified, or
  // a spoofed UA from any IP would harvest the NORG mirror. The address comes
  // from Bunny's own x-real-ip, which it replaces rather than appends.
  if (!verifiedSource(clientIp(originRequest), feed.cidrRanges, classification)) {
    return PASSTHROUGH;
  }

  return serveAgent(originRequest, request, env, url, classification);
}

/**
 * The request pipeline — routing only; each branch delegates.
 *
 * Order is load-bearing. Humans, search crawlers and static assets leave
 * before the feed is touched, so a person never waits on NORG; only a
 * bot-shaped request pays for the lookup.
 *
 * @param {Request} originRequest Origin-pointed request from the hook.
 * @param {Object} env Install config.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
export async function handleRequest(originRequest, env) {
  const url = visitorUrl(originRequest);
  const request = toVisitorRequest(originRequest, url);

  if (isHealthProbe(request, env)) {
    // Fetch before answering: the cached verdict starts unentitled, so a probe
    // on a cold isolate reported entitled:false for a site NORG would serve.
    await getBotFeed(env);
    return healthResponse(env, isEntitled());
  }
  if (isPassthrough(originRequest, url, env)) return PASSTHROUGH;

  // The human fast path: no feed, no NORG. A passthrough event is sent only
  // when the install opts in, behind the response via Bunny's waitUntil.
  const exit = fastPathExit(request, url, request.headers.get("user-agent") || "");
  if (exit) {
    if (exit === "human") reportPassthrough(env, request, anonymousClassification());
    return PASSTHROUGH;
  }

  // Entitlement gate. Everything below this line serves NORG content or alters
  // the origin response, so none of it may run until NORG has authenticated
  // this install. Unentitled, the visitor gets the customer's ordinary page and
  // cannot tell the router is installed. A stale feed refreshes behind the
  // response through the keep-alive.
  const feed = await getBotFeed(env);
  if (!feed.entitled) return PASSTHROUGH;

  const owned = await serveNorgOwnedSurface(originRequest, env, url);
  if (owned) return owned;

  // The agentic subtree is answered by URL for every caller — humans, search
  // engines and agents alike get identical bytes — so it runs before the
  // search-engine floor and all classification.
  if (isAgenticPath(url.pathname, feed.agenticPathPrefix)) {
    return serveAgenticPath(request, env, url, feed.agenticPathPrefix);
  }

  // Per-page sibling artifacts are advertised as absolute URLs in the page's
  // own mcp.json, so an MCP client fetches them WITHOUT being a verified bot.
  if (isSiblingArtifactPath(url.pathname)) {
    if (isSkippedPath(feed, siblingPageOf(url.pathname))) return PASSTHROUGH;
    return serveOriginFirstArtifact(originRequest, env, url, true);
  }

  // Static subresources are never a mirrorable document. Deliberately placed
  // AFTER every NORG-owned surface above, because some of them legitimately end
  // in an extension this set matches.
  if (isStaticAssetPath(url.pathname)) return PASSTHROUGH;

  // The operator marked this exact path to pass through untouched.
  if (isSkippedPath(feed, url.pathname)) return PASSTHROUGH;

  // Search engines see exactly what humans see. Checked before classification
  // so it holds even when the feed is stale, and before the ?agent=true
  // override because that override is ungated. The floor is the one thing
  // nothing overrides.
  if (isTraditionalSearchBot(request.headers.get("user-agent") || "")) return PASSTHROUGH;

  return serveClassified(originRequest, request, env, url, feed);
}

// Test-only exports.
export {
  isHealthProbe as __test_isHealthProbe,
  isPassthrough as __test_isPassthrough,
  serveStrippedOrigin as __test_serveStrippedOrigin,
  toVisitorRequest as __test_toVisitorRequest,
};
