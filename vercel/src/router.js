/**
 * NORG.ai Content-Craft Platform — Edge Router (Vercel)
 *
 * The request pipeline for Next.js middleware and Vercel Routing Middleware.
 * Serves NORG-optimised content to AI agents at the customer's own URLs, and
 * leaves every other visitor's experience unchanged.
 *
 * @description Edge-routing pipeline for Vercel; null means "serve the site".
 */

/*
 * This is the Vercel port of workers/edge-router-worker.js, built on the same
 * provider-neutral core as the CloudFront, Fastly and Bunny ports. The
 * pipeline in handleRequest is the same pipeline, in the same order, under
 * the same three rules:
 *
 *  1. THIS MUST NEVER BREAK THE CUSTOMER'S SITE. Every failure path returns
 *     null, which the entry point turns into "carry on to the application" —
 *     the page renders exactly as if this package were not installed.
 *  2. SEARCH ENGINES ARE NOT AI AGENTS. Googlebot and friends always get the
 *     site. There is deliberately no flag to turn this off.
 *  3. NOTHING HAPPENS WITHOUT AN AUTHENTICATED FEED. NORG_SITE_ID and
 *     NORG_SITE_KEY are compulsory, and until one NORG call succeeds the
 *     router changes nothing at all.
 *
 * WHAT DIFFERS FROM CLOUDFLARE, and why:
 *
 *  - Middleware runs before Vercel's cache and before the application, on
 *    every request the matcher admits, so the human fast path (core/fastpath)
 *    answers ordinary visitors before any lookup.
 *  - "Serve the origin" is not a fetch: the handler returns nothing and Vercel
 *    continues to the page. Only the strip and origin-first artifacts read the
 *    page themselves (lib/origin.js).
 *  - waitUntil exists (NextFetchEvent / Vercel's request context), so feed
 *    refreshes and heartbeats land after the response (EDGE_KEEPALIVE).
 *  - No verified-bot signal: source verification is CIDR-only (lib/request.js).
 *  - No Cache API and no HTMLRewriter: the feed is held per instance and the
 *    strip is core's tokenizer, as on CloudFront.
 *  - Agent visits are recorded by the receptionist from the X-Norg-Visit
 *    header on the mirror fetch (core/visit.js), as on CloudFront.
 */

import { withAlternateFormatHeaders } from "../../workers/lib/alternate-format.mjs";
import { isAgenticPath, pathToKeySuffix } from "../../workers/lib/r2-content.mjs";
import { mcpForwardHeaders } from "../../workers/lib/mcp-forward.mjs";

import { LOOP_GUARD_HEADER, MCP_FORWARD_TIMEOUT_MS, STRIP_WORD_FLOOR } from "../../core/constants.mjs";
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
import { edgeFetch, timeoutSignal } from "../../core/http.js";
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

import { maybeHeartbeat } from "./lib/heartbeat.js";
import { fetchOrigin } from "./lib/origin.js";
import { clientIp, edgeRegion, visitView } from "./lib/request.js";

// Paths whose answer is never an HTML page, so never a strip candidate.
const NON_HTML_PATH = /\.(txt|xml|json|jsonld|rss|atom|csv|md|pdf|ya?ml)$/i;

/**
 * Compare two strings in time that depends only on their length.
 *
 * The Edge runtime has no node:crypto timingSafeEqual, so this is the plain
 * XOR-accumulate form. Length is compared first and leaks only that, which
 * is public anyway: every site key has the same shape.
 *
 * @param {string} a First string.
 * @param {string} b Second string.
 * @returns {boolean} True when identical.
 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Is this an authenticated health probe rather than a real visit?
 *
 * The presented key is compared in constant time: the probe header is the
 * one place a caller can present a guess at the site key and observe a
 * response, so the comparison must not leak how much of it was right.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @returns {boolean} True when the probe key matches.
 */
function isHealthProbe(request, env) {
  const probeKey = request.headers.get("x-norg-edge-check");
  return Boolean(probeKey && env.NORG_SITE_KEY && constantTimeEqual(probeKey, env.NORG_SITE_KEY));
}

// An MCP JSON-RPC request is small; a body over this is not one, and is
// refused rather than buffered. Falls through to the site like any other miss.
const MCP_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Should this request skip interception entirely?
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @returns {boolean} True to pass straight to the application.
 */
function isPassthrough(request, env) {
  if (binding(env, "EDGE_DISABLED") === "true") return true;
  if (request.headers.get(LOOP_GUARD_HEADER)) return true;
  if (request.headers.get("upgrade")) return true;
  const method = request.method;
  if (method === "GET") return false;
  // HEAD must answer as GET does, and these paths exist only in NORG's bucket.
  const pathname = new URL(request.url).pathname;
  if (method === "HEAD" && isNorgOwnedArtifactPath(pathname)) return false;
  // MCP is the one surface that accepts POST (JSON-RPC transport).
  if (method === "POST" && isMcpPath(pathname)) return false;
  return true;
}

/**
 * The headers that let the receptionist record this visit and act on a miss.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {Object} classification Bot classification.
 * @param {string} served Label on a hit.
 * @param {string} servedOnMiss Label on a miss.
 * @param {boolean} lazyRender Whether a miss should enqueue a render.
 * @returns {Object} Extra headers for fetchFromNorg.
 */
function visitHeaders(request, env, classification, served, servedOnMiss, lazyRender) {
  const headers = {
    "X-Norg-Visit": visitHeader(visitView(request), classification, served, servedOnMiss),
  };
  if (lazyRender && binding(env, "LAZY_RENDER_ENABLED") !== "false") {
    headers["X-Norg-Lazy-Render"] = "1";
  }
  return headers;
}

/**
 * Serve a NORG-published artifact origin-first.
 *
 * A 200 with a non-HTML content type is the customer's own file and wins (by
 * passthrough, so the application serves it itself). An error, a 404 or an
 * HTML 200 (a soft-404) means the site has none, so NORG's copy is served.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {boolean} alternateFormatHeaders Apply canonical Link + noindex.
 * @returns {Promise<?Response>} Response, or null to serve the site.
 */
async function serveOriginFirstArtifact(request, env, url, alternateFormatHeaders) {
  const origin = await fetchOrigin(request);
  if (origin && origin.status === 200) {
    const contentType = origin.headers.get("content-type") || "";
    if (!/text\/html/i.test(contentType)) return null;
  }
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  if (!response) return null;
  const served = mirrorResponse(response, env);
  return alternateFormatHeaders ? withAlternateFormatHeaders(served, url, url.pathname) : served;
}

/**
 * Serve the MCP surface for a page: GET reads the artifact, POST forwards.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response>} Response, or null to serve the site.
 */
async function handleMcp(request, env, url) {
  if (request.method === "POST") return forwardMcpToNorg(request, env, url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const suffix =
    url.pathname === "/.well-known/mcp.json"
      ? "/.well-known/mcp.json"
      : `${url.pathname.replace(/\/(mcp|sse)$/, "")}/mcp.json`;
  const { response } = await fetchFromNorg(env, suffix);
  return response ? mcpResponse(response) : null;
}

/**
 * Forward an MCP JSON-RPC request to NORG's public MCP endpoint.
 *
 * NORG's answer is returned only when it is 2xx (a JSON-RPC error arrives as
 * 200 and is the caller's answer); anything else falls back to the site, so a
 * customer's own /mcp route keeps working. Only the headers JSON-RPC needs are
 * relayed: a Cookie or Authorization header never reaches NORG.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response>} NORG's 2xx response, or null.
 */
async function forwardMcpToNorg(request, env, url) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(declared) || declared > MCP_MAX_BODY_BYTES) return null;
  try {
    const headers = mcpForwardHeaders(request.headers);
    headers.set("X-Norg-Site-Id", env.SITE_ID || "");
    headers.set("X-Norg-Site-Key", env.NORG_SITE_KEY || "");
    headers.set("X-Norg-Edge-Page", url.pathname);
    headers.set("X-Norg-Edge-Version", env.EDGE_SCRIPT_VERSION);
    // The trailing slash is load-bearing: "/public-mcp" answers 307, and this
    // POST's body cannot be replayed onto the redirect.
    const response = await edgeFetch(env, `${binding(env, "NORG_API_URL")}/public-mcp/`, {
      method: "POST",
      headers,
      body: await request.clone().arrayBuffer(),
      signal: timeoutSignal(MCP_FORWARD_TIMEOUT_MS),
    });
    return response.ok ? response : null;
  } catch (e) {
    console.error("norg edge mcp forward failed", e);
    return null;
  }
}

/**
 * The NORG-owned surfaces, served before any classification.
 *
 * Each is served to every caller from identical bytes, which is exactly why
 * none of them is a cloaking surface.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response|undefined>} Response, null to serve the site,
 *   or undefined when this is not a NORG-owned surface.
 */
async function serveNorgOwnedSurface(request, env, url) {
  const pathname = url.pathname;
  if (isMcpPath(pathname)) return handleMcp(request, env, url);
  if (isDiscoveryPath(pathname)) return serveOriginFirstArtifact(request, env, url, false);
  if (isReservedNorgPath(pathname)) {
    const { response } = await fetchFromNorg(env, pathToKeySuffix(pathname));
    return response ? reservedAssetResponse(response, env) : null;
  }
  if (isOpenAiFeedPath(pathname)) {
    const { response } = await fetchFromNorg(env, pathToKeySuffix(pathname));
    return response ? openAiFeedResponse(response, env, pathname) : null;
  }
  return undefined;
}

/**
 * Serve a mirror object for a URL-addressed surface (agentic path, override).
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {string} innerPath Path whose render to read.
 * @param {Object} classification Classification to record.
 * @param {string} served Label on a hit; "<served>_miss" on a miss.
 * @returns {Promise<?Response>} Response, or null to serve the site.
 */
async function serveAddressedMirror(request, env, url, innerPath, classification, served) {
  const headers = visitHeaders(request, env, classification, served, `${served}_miss`, false);
  const { response } = await fetchFromNorg(env, pathToKeySuffix(innerPath), headers);
  if (!response) return null;
  return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
}

/**
 * Serve the site stripped to a token-dense form, where that helps.
 *
 * Under STRIP_WORD_FLOOR visible words — a client-rendered page whose content
 * the strip removes — the stripped page carries less than the original, so
 * the site is served untouched. So is any answer that is not a 200 HTML page.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @returns {Promise<?Response>} Stripped response, or null.
 */
async function serveStrippedOrigin(request, env) {
  if (binding(env, "STRIP_FALLBACK_ENABLED") === "false") return null;
  const origin = await fetchOrigin(request);
  if (!origin) return null;
  const contentType = origin.headers.get("content-type") || "";
  if (origin.status !== 200 || !/text\/html/i.test(contentType)) return null;
  const stripped = stripHtml(await origin.text());
  if (countVisibleWords(stripped) < STRIP_WORD_FLOOR) return null;
  return strippedResponse(stripped, origin.status, env);
}

/**
 * Serve a verified AI agent: the NORG render, else the stripped page.
 *
 * One NORG call. The visit header on it records the event and, on a miss,
 * enqueues the render — neither is a call of this function's own.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {Object} classification Bot classification.
 * @returns {Promise<?Response>} Response, or null to serve the site.
 */
async function serveAgent(request, env, url, classification) {
  const missIntent = binding(env, "STRIP_FALLBACK_ENABLED") === "false" ? "origin" : "stripped";
  const headers = visitHeaders(request, env, classification, "mirror", missIntent, true);
  const { response, refused } = await fetchFromNorg(env, pathToKeySuffix(url.pathname), headers);
  maybeHeartbeat(env, "traffic", edgeRegion(request));
  if (response) return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
  if (refused || NON_HTML_PATH.test(url.pathname)) return null;
  return serveStrippedOrigin(request, env);
}

/**
 * Answer an authenticated health probe, fetching the feed first.
 *
 * The cached verdict starts unentitled, so a probe on a cold instance would
 * otherwise report entitled:false for a site NORG serves.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @returns {Promise<Response>} JSON status.
 */
async function answerHealthProbe(request, env) {
  await getBotFeed(env);
  maybeHeartbeat(env, "probe", edgeRegion(request));
  return healthResponse(env, isEntitled());
}

/**
 * Classify a request that reached the agent stage, and serve it if verified.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {Object} feed Authenticated feed.
 * @param {Object} options Factory options (client-IP trust).
 * @returns {Promise<?Response>} Response, or null to serve the site.
 */
async function serveClassified(request, env, url, feed, options) {
  const userAgent = request.headers.get("user-agent") || "";
  // Rule 2 — before the ?agent=true override, because that override is
  // ungated and a crawler must never be answered with the NORG render.
  if (isTraditionalSearchBot(userAgent)) return null;
  if (hasAgentOverride(url)) {
    return serveAddressedMirror(
      request, env, url, url.pathname, agentOverrideClassification(), "agent_param_override",
    );
  }
  const classification = classifyAgent(userAgent, feed.patterns);
  if (!classification.is_ai_bot || !mayDivert(classification)) return null;
  // A spoofable UA is not enough: the source IP must be the operator's.
  if (!verifiedSource(clientIp(request, options), feed.cidrRanges, classification)) return null;
  return serveAgent(request, env, url, classification);
}

/**
 * The request pipeline — routing only; each branch delegates.
 *
 * Order is load-bearing. Humans, search crawlers and static assets leave
 * before the feed is touched, so a person never waits on NORG.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {Object} [options] Factory options.
 * @returns {Promise<?Response>} Response, or null to serve the site.
 */
export async function handleRequest(request, env, options = {}) {
  if (isHealthProbe(request, env)) return answerHealthProbe(request, env);
  if (isPassthrough(request, env)) return null;

  const url = new URL(request.url);
  const exit = fastPathExit(request, url, request.headers.get("user-agent") || "");
  if (exit) {
    if (exit === "human") reportPassthrough(env, request, anonymousClassification());
    return null;
  }

  // Entitlement gate: nothing below runs until NORG has authenticated this
  // install. Refused, or never authenticated and unreachable, is a passthrough.
  const feed = await getBotFeed(env);
  if (!feed.entitled) return null;

  const owned = await serveNorgOwnedSurface(request, env, url);
  if (owned !== undefined) return owned;

  // The agentic subtree is answered by URL for every caller, so it runs
  // before the search-engine floor and all classification.
  if (isAgenticPath(url.pathname, feed.agenticPathPrefix)) {
    const inner = url.pathname.slice(feed.agenticPathPrefix.length) || "/";
    return serveAddressedMirror(
      request, env, url, inner, anonymousClassification(), "agentic_path",
    );
  }
  // Per-page siblings are advertised in the page's own mcp.json, so an MCP
  // client fetches them without being a verified bot. A skipped page's
  // siblings are skipped too: they carry the same text.
  if (isSiblingArtifactPath(url.pathname)) {
    if (isSkippedPath(feed, siblingPageOf(url.pathname))) return null;
    return serveOriginFirstArtifact(request, env, url, true);
  }
  if (isStaticAssetPath(url.pathname) || isSkippedPath(feed, url.pathname)) return null;
  return serveClassified(request, env, url, feed, options);
}

// Test-only exports.
export {
  constantTimeEqual as __test_constantTimeEqual,
  isHealthProbe as __test_isHealthProbe,
  isPassthrough as __test_isPassthrough,
  serveStrippedOrigin as __test_serveStrippedOrigin,
  MCP_MAX_BODY_BYTES as __test_MCP_MAX_BODY_BYTES,
};
