/**
 * NORG.ai Content-Craft Platform — Edge Router (Fastly Compute)
 *
 * @description The request pipeline. No fastly: imports, so it is testable
 * under `node --test` with no Fastly toolchain installed — the entry point in
 * index.js is the only file that touches the platform SDK.
 */

/*
 * The Fastly port of workers/edge-router-worker.js. The pipeline in
 * handleRequest is the same pipeline, in the same order, and the three rules
 * that govern the Cloudflare worker govern this file too:
 *
 *  1. THIS MUST NEVER BREAK THE CUSTOMER'S SITE. Every failure path ends at the
 *     origin. Here that is nearly free — unlike Lambda@Edge, passthrough is a
 *     real Response, so the top-level catch simply fetches the origin.
 *  2. SEARCH ENGINES ARE NOT AI AGENTS. Googlebot and friends always get the
 *     origin. There is no flag to turn this off.
 *  3. NOTHING HAPPENS WITHOUT AN AUTHENTICATED FEED.
 *
 * WHY THIS PORT IS SHORT. Nearly everything lives in core/ and is shared with
 * the other providers: classification, the feed and entitlement gate, the strip
 * rewriter, path predicates, telemetry, constants and exclusions. Fastly needs
 * only two adapters — config (Config Store + Secret Store) and origin
 * (backends) — because its runtime already speaks standard Request/Response.
 *
 * WHAT FASTLY GIVES US THAT CLOUDFRONT DID NOT:
 *  - A real `waitUntil`, so the stale-feed refresh and the opt-in passthrough
 *    event run behind the response (index.js hands them to it as
 *    EDGE_KEEPALIVE).
 *  - No generated-response cap, so a mirror is always returned inline WITH its
 *    X-Norg-Edge headers — no origin-switch fallback.
 *  - A write-only Secret Store for NORG_SITE_KEY.
 *  - No Host-must-match-origin rule, so a host-aware origin sees the hostname
 *    the visitor actually typed.
 *
 * WHAT IS THE SAME AS EVERYWHERE ELSE, since 0.2.0:
 *  - Humans never wait on NORG. An ordinary browser, a search crawler and a
 *    static asset are passed through before the feed is touched
 *    (core/fastpath.js).
 *  - The router makes no call of its own to report a visit. The details ride
 *    as one header on the mirror fetch it awaits anyway (core/visit.js), and
 *    the receptionist records the event and, on a miss, enqueues the render.
 *  - The page is never cached at the edge. Every page passthrough carries a
 *    pass override (lib/origin.js); only static assets keep Fastly's cache.
 *
 * WHAT IT STILL LACKS: cron. The 30-minute heartbeat must be driven by NORG
 * pinging the install, exactly as on CloudFront's regional Lambda — except here
 * there is no in-account scheduler to put it in.
 */

import { withAlternateFormatHeaders } from "../../workers/lib/alternate-format.mjs";
import { isAgenticPath, pathToKeySuffix } from "../../workers/lib/r2-content.mjs";

import {
  HEALTH_CHECK_HEADER,
  LOOP_GUARD_HEADER,
  STRIP_WORD_FLOOR,
} from "../../core/constants.mjs";
import { binding, isConfigured } from "../../core/config.js";
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

import { fetchOrigin, passthrough } from "./lib/origin.js";

/**
 * Route an outbound URL to the backend that serves it.
 *
 * Fastly requires every fetch to name a declared backend. Declaring all three
 * statically (rather than switching on dynamic backends) keeps the set of hosts
 * this router can reach auditable by the customer in their own service config.
 *
 * @param {Object} env Install config.
 * @returns {function(string, Object): Promise<Response>} A fetch implementation.
 */
export function backendFetch(env) {
  const apiHost = new URL(binding(env, "NORG_API_URL")).host;
  const contentHost = new URL(binding(env, "NORG_CONTENT_BASE")).host;

  return (url, init) => {
    const host = new URL(url).host;
    const backend = host === apiHost ? "norg_api" : host === contentHost ? "norg_content" : null;
    if (!backend) {
      return Promise.reject(new Error(`no backend declared for ${host}`));
    }
    return fetch(url, { ...init, backend });
  };
}

/**
 * Is this an authenticated health probe rather than a real visit?
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
 * @param {Object} env Install config.
 * @returns {boolean} True to pass straight to origin.
 */
function isPassthrough(request, env) {
  if (binding(env, "EDGE_DISABLED") === "true") return true;
  if (request.headers.get(LOOP_GUARD_HEADER)) return true;
  if (request.headers.get("upgrade")) return true;

  const method = request.method;
  if (method === "GET") return false;
  const pathname = new URL(request.url).pathname;
  // HEAD must answer with the SAME status and headers as GET (RFC 9110), and
  // these paths exist only in NORG's bucket.
  if (method === "HEAD" && isNorgOwnedArtifactPath(pathname)) return false;
  if (method === "POST" && isMcpPath(pathname)) return false;
  return true;
}

/**
 * Serve a NORG-published artifact origin-first.
 *
 * A 200 with a non-HTML content type is the customer's own file and wins. An
 * HTML 200 is a SPA soft-404, so NORG's copy is served instead.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {boolean} alternateFormatHeaders Apply canonical Link + noindex.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveOriginFirstArtifact(request, env, url, alternateFormatHeaders) {
  let origin = null;
  try {
    origin = await fetchOrigin(request, env);
  } catch (e) {
    console.error("norg edge artifact origin probe failed", e);
  }
  if (origin && origin.status === 200) {
    const contentType = origin.headers.get("content-type") || "";
    if (!/text\/html/i.test(contentType)) return origin;
  }

  // Never the origin's own error from here: the passthrough fetch is the one
  // the platform would have made without us.
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  if (!response) return passthrough(request, env);

  const served = mirrorResponse(response, env);
  return alternateFormatHeaders
    ? withAlternateFormatHeaders(served, url, url.pathname)
    : served;
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
 * Serve an AI agent: the NORG render if it exists, else the stripped origin.
 *
 * One NORG call, which the visitor was always going to wait for. The visit
 * header on it is how the event is recorded and how a miss enqueues a render;
 * neither is a call of this function's own. A thin strip is reported as
 * "stripped" by the receptionist because the decision is made after it
 * answered — `origin_thin` and the word count are not distinguished on this
 * provider. No size branch, unlike CloudFront: Fastly imposes no cap on a
 * generated response, so the mirror is always returned inline and labelled.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {Object} classification Bot classification.
 * @returns {Promise<Response>} Response for the agent.
 */
async function serveAgent(request, env, url, classification) {
  const headers = visitHeaders(request, env, classification, "mirror", missIntent(env), true);
  const { response, refused } = await fetchFromNorg(env, pathToKeySuffix(url.pathname), headers);
  if (response) return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
  // A refused install changes nothing, this request included: no strip.
  if (refused) return passthrough(request, env);
  return serveStrippedOrigin(request, env);
}

/**
 * Serve the origin, stripped to a token-dense form where possible.
 *
 * If the strip leaves fewer than STRIP_WORD_FLOOR visible words — a
 * client-rendered origin whose real content the strip removes — the stripped
 * page carries less than the origin, so the origin is served untouched. Any
 * origin answer that is not a 200 HTML page is served by passthrough as well,
 * never relayed from here.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @returns {Promise<Response>} Response for the agent.
 */
async function serveStrippedOrigin(request, env) {
  if (binding(env, "STRIP_FALLBACK_ENABLED") === "false") return passthrough(request, env);

  const origin = await fetchOrigin(request, env);
  const contentType = origin.headers.get("content-type") || "";
  if (origin.status !== 200 || !/text\/html/i.test(contentType)) return passthrough(request, env);

  // Buffering is safe here: 128 MB heap, and the word floor cannot be applied
  // without measuring the result first.
  const html = await origin.text();
  const stripped = stripHtml(html);
  if (countVisibleWords(stripped) < STRIP_WORD_FLOOR) return passthrough(request, env);

  return strippedResponse(stripped, origin.status, env);
}

/**
 * Serve the agentic subtree from the NORG render.
 *
 * Addressed by URL, not by caller, so there is no classification and no
 * cloaking question. A miss is a passthrough, never a synthesised 404.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {string} prefix Configured agentic prefix.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveAgenticPath(request, env, url, prefix) {
  const innerPath = url.pathname.slice(prefix.length) || "/";
  const headers = visitHeaders(
    request, env, anonymousClassification(), "agentic_path", "agentic_path_miss", false,
  );
  const { response } = await fetchFromNorg(env, pathToKeySuffix(innerPath), headers);
  if (!response) return passthrough(request, env);
  return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
}

/**
 * Serve the mirror for a ?agent=true override, bypassing UA/IP classification.
 *
 * Traditional search engines never reach here — the floor runs first. No render
 * is enqueued: param-driven demo traffic must not trigger renders.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<Response>} Response for the visitor.
 */
async function serveAgentOverride(request, env, url) {
  const headers = visitHeaders(
    request, env, agentOverrideClassification(),
    "agent_param_override", "agent_param_override_miss", false,
  );
  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname), headers);
  if (!response) return passthrough(request, env);
  return withAlternateFormatHeaders(mirrorResponse(response, env), url, url.pathname);
}

/**
 * The NORG-owned surfaces, served before any classification.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response>} Response, or null when none applies.
 */
async function serveNorgOwnedSurface(request, env, url) {
  const pathname = url.pathname;

  if (isMcpPath(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return passthrough(request, env);
    const suffix =
      pathname === "/.well-known/mcp.json"
        ? "/.well-known/mcp.json"
        : `${pathname.replace(/\/(mcp|sse)$/, "")}/mcp.json`;
    const { response } = await fetchFromNorg(env, suffix);
    return response ? mcpResponse(response) : passthrough(request, env);
  }
  if (isDiscoveryPath(pathname)) {
    return serveOriginFirstArtifact(request, env, url, false);
  }
  if (isReservedNorgPath(pathname)) {
    const { response } = await fetchFromNorg(env, pathToKeySuffix(pathname));
    return response ? reservedAssetResponse(response, env) : passthrough(request, env);
  }
  if (isOpenAiFeedPath(pathname)) {
    const { response } = await fetchFromNorg(env, pathToKeySuffix(pathname));
    return response ? openAiFeedResponse(response, env, pathname) : passthrough(request, env);
  }
  return null;
}

/**
 * The request pipeline — routing only; each branch delegates.
 *
 * Order is load-bearing. Humans, search crawlers and static assets leave
 * before the feed is touched, so a person never waits on NORG; only a
 * bot-shaped request pays for the lookups.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {string} clientIp Viewer IP from the Fastly event.
 * @returns {Promise<Response>} Response for the visitor.
 */
export async function handleRequest(request, env, clientIp) {
  if (isHealthProbe(request, env)) {
    // Fetch before answering: the cached verdict starts unentitled, so a probe
    // on a cold isolate reported entitled:false for a site NORG would serve.
    await getBotFeed(env);
    return healthResponse(env, isEntitled());
  }
  if (isPassthrough(request, env)) return passthrough(request, env);

  const url = new URL(request.url);
  const userAgent = request.headers.get("user-agent") || "";

  // The human fast path: no feed, no NORG. A passthrough event is sent only
  // when the install opts in, and then behind the response via waitUntil.
  const exit = fastPathExit(request, url, userAgent);
  if (exit) {
    if (exit === "human") reportPassthrough(env, request, anonymousClassification());
    return passthrough(request, env);
  }

  // Entitlement gate. Nothing below runs until NORG has authenticated this
  // install; unentitled, the visitor gets the customer's ordinary page and
  // cannot tell the router is installed. A stale feed refreshes behind the
  // response, through the keep-alive index.js provides.
  const feed = await getBotFeed(env);
  if (!feed.entitled) return passthrough(request, env);

  const owned = await serveNorgOwnedSurface(request, env, url);
  if (owned) return owned;

  if (isAgenticPath(url.pathname, feed.agenticPathPrefix)) {
    return serveAgenticPath(request, env, url, feed.agenticPathPrefix);
  }

  if (isSiblingArtifactPath(url.pathname)) {
    if (isSkippedPath(feed, siblingPageOf(url.pathname))) return passthrough(request, env);
    return serveOriginFirstArtifact(request, env, url, true);
  }

  if (isStaticAssetPath(url.pathname)) return passthrough(request, env);
  if (isSkippedPath(feed, url.pathname)) return passthrough(request, env);

  // Search engines see exactly what humans see. Checked before classification
  // and before the ?agent=true override, because answering a crawler with the
  // NORG render is the cloaking rule 2 forbids.
  if (isTraditionalSearchBot(userAgent)) return passthrough(request, env);

  if (hasAgentOverride(url)) return serveAgentOverride(request, env, url);

  const classification = classifyAgent(userAgent, feed.patterns);
  if (!classification.is_ai_bot) return passthrough(request, env);
  if (!mayDivert(classification)) return passthrough(request, env);
  if (!verifiedSource(clientIp, feed.cidrRanges, classification)) return passthrough(request, env);

  return serveAgent(request, env, url, classification);
}
