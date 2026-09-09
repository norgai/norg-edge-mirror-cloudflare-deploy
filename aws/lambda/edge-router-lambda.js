/**
 * NORG.ai Content-Craft Platform — Edge Router (AWS CloudFront)
 *
 * Lambda@Edge origin-request function for a customer-owned CloudFront
 * distribution. Serves NORG-optimised content to AI agents at the customer's
 * own URLs, and leaves every other visitor's experience unchanged.
 *
 * @description Edge-routing Lambda@Edge function for customer CloudFront.
 */

/*
 * This is the CloudFront port of workers/edge-router-worker.js. The pipeline in
 * handleRequest is the same pipeline, in the same order, and the three rules
 * that govern the Cloudflare worker govern this file too:
 *
 *  1. THIS MUST NEVER BREAK THE CUSTOMER'S SITE. Every failure path ends at
 *     the origin. On Cloudflare that is nearly free, because the top-level
 *     catch calls fetch(request) and returns a real response. HERE IT IS NOT:
 *     a Lambda@Edge function that throws, or that runs past its timeout, makes
 *     CloudFront return 502 to the visitor. The guarantee therefore has to be
 *     constructed — see `handler`, which wraps everything and additionally
 *     races a watchdog, so a hung NORG cannot turn into an error page.
 *
 *  2. SEARCH ENGINES ARE NOT AI AGENTS. Googlebot and friends always get the
 *     origin. Serving them different content than humans is cloaking and would
 *     put the customer's rankings at risk. There is deliberately no flag to
 *     turn this off, and nothing overrides it — not even ?agent=true.
 *
 *  3. NOTHING HAPPENS WITHOUT AN AUTHENTICATED FEED. SITE_ID + NORG_SITE_KEY
 *     are compulsory, and until one NORG call succeeds the router changes
 *     nothing at all. There is no local pattern list to fall back on.
 *
 * WHAT DIFFERS FROM CLOUDFLARE, and why. Each of these is forced by the
 * platform, not chosen:
 *
 *  - No environment variables. Config arrives as CloudFront custom origin
 *    headers and is redacted as it is read (config.js). The one SECRET does
 *    not travel that way: the key lives in Secrets Manager and is fetched at
 *    the edge (secret.js), so it is not readable from the distribution's
 *    configuration and rotation is one place rather than two.
 *  - No ctx.waitUntil, and the container freezes the instant the handler
 *    returns, so there is no background call that reliably lands and no wait
 *    a visitor should pay for one. The router therefore makes NO call of its
 *    own to report a visit: the details ride as one request header on the
 *    mirror fetch it awaits anyway (core/visit.js), and the receptionist —
 *    which runs on Cloudflare and has waitUntil — records the event and, on a
 *    miss, requests the render. The only outbound calls are the ones a
 *    response depends on.
 *  - No Cache API. The feed lives in a container global and revalidates with
 *    If-None-Match (feed.js). There is no mirror cache in the function either:
 *    the receptionist holds the mirror cache, and a request that skipped it
 *    would be a visit nobody recorded.
 *  - The human page is never cached at the edge. The default behaviour uses
 *    CloudFront's managed CachingDisabled policy, so every page request
 *    reaches this function and the origin answers as it always did. What that
 *    buys is the absence of a whole class of failure — a page cached under
 *    the wrong key — and what it costs is one invocation per page request,
 *    which is why an ordinary browser is answered before any lookup.
 *  - No HTMLRewriter. The strip is a hand-rolled tokenizer (strip.js).
 *  - No verified-bot signal. Source verification is CIDR-only (agent.js).
 *  - No cron trigger. The heartbeat is a separate scheduled Lambda.
 *  - A generated response is capped at 1 MB, so a large mirror is served by
 *    repointing the origin at NORG instead (origin.js).
 *  - "Serve the origin" returns the REQUEST, not a response (origin.js).
 *
 * Bindings (all via CloudFront custom origin headers — see config.js):
 *   SITE_ID                 edge_sites.id
 *   NORG_SECRET_ARN         Secrets Manager ARN holding the per-site key.
 *                           Compulsory (rule 3) — the ARN is an address, not a
 *                           credential, so it is safe in the distribution.
 *   PROBE_TOKEN             Authorises the health probe and nothing else.
 *   NORG_API_URL            https://content-craft-api.norg.ai
 *   NORG_CONTENT_BASE       NORG edge-content receptionist base
 *   STRIP_FALLBACK_ENABLED  "true" | "false"
 *   EDGE_DISABLED           "true" kills all interception (remote off switch)
 *   LAZY_RENDER_ENABLED     "false" serves the strip without asking for a render
 *   EDGE_ENV                "production" | "test"
 *   EDGE_EVENTS_VERBOSE     "true" also reports origin passthroughs
 */

import { withAlternateFormatHeaders } from "../../workers/lib/alternate-format.mjs";
import { isAgenticPath, pathToKeySuffix } from "../../workers/lib/r2-content.mjs";
import { mcpForwardHeaders } from "../../workers/lib/mcp-forward.mjs";

import {
  LOOP_GUARD_HEADER,
  MCP_FORWARD_TIMEOUT_MS,
  MIRROR_FETCH_TIMEOUT_MS,
  STRIP_WORD_FLOOR,
} from "../../core/constants.mjs";
import { EDGE_SCRIPT_VERSION, readConfig, scrubConfigHeaders } from "./lib/config.js";
import { __primeSecretCache, getSiteKey } from "./lib/secret.js";
import { binding, contentStem } from "../../core/config.js";
import {
  agentOverrideClassification,
  anonymousClassification,
  classifyAgent,
  mayDivert,
  verifiedSource,
} from "../../core/agent.js";
import { fastPathExit } from "../../core/fastpath.js";
import { getBotFeed, isEntitled } from "../../core/feed.js";
import { clientIp, passthrough as toPassthrough, toCloudFrontResponse, toRequest } from "./lib/event.js";
import {
  PASSTHROUGH,
  alignHostToOrigin,
  fetchOrigin,
  switchOriginToNorg,
} from "./lib/origin.js";
import {
  fetchFromNorg,
  healthResponse,
  mcpResponse,
  mirrorResponse,
  openAiFeedResponse,
  receptionistHeaders,
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

// Leaves a margin under Lambda@Edge's 30s origin-request ceiling. Hitting the
// platform timeout is a 502; hitting this is an origin passthrough.
const WATCHDOG_MS = 20_000;

// Above this the mirror is served by repointing the origin rather than as a
// generated response, which CloudFront caps at 1 MB.
const MAX_INLINE_MIRROR_BYTES = 850 * 1024;


/**
 * Is this an authenticated health probe rather than a real visit?
 *
 * The key comparison is not constant-time. A successful probe reveals only the
 * site id and script version, both of which the operator running the probe
 * already knows, so the simple comparison is deliberate.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @returns {boolean} True when the probe key matches.
 */
function isHealthProbe(request, env) {
  // Read from env, not from the request: readConfig captures the header and
  // strips it in the same pass, so a failing probe cannot carry it onward to
  // the customer's origin. Compared against the probe token rather than the
  // site key, so the documented curl no longer puts a NORG credential on the
  // wire.
  const probeKey = env.PROBE_HEADER;
  return Boolean(probeKey && env.PROBE_TOKEN && probeKey === env.PROBE_TOKEN);
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
  // HEAD must answer with the SAME status and headers as GET (RFC 9110), and
  // these paths exist only in NORG's bucket — passing HEAD to the origin would
  // 404 every one of them while GET returned 200. Scoped to the paths this
  // router owns: a HEAD to a customer page belongs to their application.
  const pathname = new URL(request.url).pathname;
  if (method === "HEAD" && isNorgOwnedArtifactPath(pathname)) return false;
  // MCP is the one surface that accepts POST (JSON-RPC transport).
  if (method === "POST" && isMcpPath(pathname)) return false;
  return true;
}

/**
 * Serve a NORG-published artifact origin-first.
 *
 * A 200 with a non-HTML content type is the customer's own file and wins,
 * passed through byte-for-byte. A 404/error, or an HTML 200 (a SPA soft-404,
 * not a real artifact), means the origin has none, so the NORG copy is served.
 * On a receptionist miss the request falls through to ordinary passthrough —
 * never a synthesised NORG error page, and never the origin's own error
 * response either: CloudFront fetches that itself, with the headers the origin
 * expects.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {boolean} alternateFormatHeaders Apply canonical Link + noindex.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveOriginFirstArtifact(cfRequest, request, env, url, alternateFormatHeaders) {
  const origin = await fetchOrigin(cfRequest, request, MIRROR_FETCH_TIMEOUT_MS);
  if (origin && origin.status === 200) {
    const contentType = origin.headers.get("content-type") || "";
    // A real llms.txt/tree.json is never HTML; an HTML 200 is a SPA soft-404.
    if (!/text\/html/i.test(contentType)) return origin;
  }

  const { response } = await fetchFromNorg(env, pathToKeySuffix(url.pathname));
  if (!response) return PASSTHROUGH;

  const served = mirrorResponse(response, env);
  return alternateFormatHeaders
    ? withAlternateFormatHeaders(served, url, url.pathname)
    : served;
}

/**
 * Serve the MCP surface for a page.
 *
 * GET reads the static artifact published alongside the render. POST is the
 * JSON-RPC transport and is forwarded to NORG. A miss falls through to the
 * origin for GET and POST alike, so a customer's own /mcp route keeps working.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response>} Response, or null to fall through to origin.
 */
async function handleMcp(request, env, url) {
  if (request.method === "POST") return forwardMcpToNorg(request, env, url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  // "/products/x/mcp" -> "/products/x/mcp.json"; "/mcp" -> "/mcp.json".
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
 * Returns NORG's response ONLY when NORG can serve the request; otherwise null
 * so the caller falls back to the customer origin (rule 1). The boundary is
 * status-based: HTTP 2xx is returned as-is, because a JSON-RPC application
 * error arrives as HTTP 200 and IS the caller's answer. Any non-2xx, throw or
 * timeout means "NORG cannot serve this".
 *
 * Only the headers JSON-RPC needs are relayed (workers/lib/mcp-forward.mjs): a
 * Cookie or Authorization header sent to the customer's domain never reaches
 * NORG.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?Response>} NORG's 2xx response, or null on any miss.
 */
async function forwardMcpToNorg(request, env, url) {
  try {
    const headers = mcpForwardHeaders(request.headers);
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
      body: await request.arrayBuffer(),
      signal: AbortSignal.timeout(MCP_FORWARD_TIMEOUT_MS),
    });
    return response.ok ? response : null;
  } catch (e) {
    console.error("norg edge mcp forward failed", e);
    return null;
  }
}

/**
 * Serve a mirror object, inline when small enough and by origin switch when not.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Response} response Receptionist response.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {string} keySuffix Mirror key suffix.
 * @returns {Response|Object} Response, or PASSTHROUGH after an origin switch.
 */
async function serveMirror(cfRequest, response, env, url, keySuffix) {
  const switchOrigin = () =>
    switchOriginToNorg(cfRequest, contentStem(env), keySuffix, receptionistHeaders(env));

  // A DECLARED length over the cap is handed straight to CloudFront: there is
  // no point buffering a body we already know we cannot return.
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (!Number.isFinite(declared) || declared > MAX_INLINE_MIRROR_BYTES) return switchOrigin();
  }

  // An ABSENT length is the normal case, not the exception: the receptionist is
  // a Workers service that streams over HTTP/2 and sends no content-length at
  // all. Treating unknown as "too large" therefore made the origin-switch
  // fallback the only path ever taken — and on that path CloudFront fetches the
  // mirror itself, so nothing here can stamp X-Norg-Edge, the no-store
  // directives or X-Norg-Edge-Env. Every mirror was served without the headers
  // that identify it, which is what the install's own verification checks for.
  //
  // So buffer instead, and only fall back when the bytes actually overflow.
  const buffered = Buffer.from(await response.arrayBuffer());
  if (buffered.byteLength > MAX_INLINE_MIRROR_BYTES) return switchOrigin();

  const inlined = new Response(buffered, { status: 200, headers: response.headers });
  return withAlternateFormatHeaders(mirrorResponse(inlined, env), url, url.pathname);
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
 * provider.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {Object} classification Bot classification.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveAgent(cfRequest, request, env, url, classification) {
  const keySuffix = pathToKeySuffix(url.pathname);
  const headers = visitHeaders(request, env, classification, "mirror", missIntent(env), true);
  const { response, refused } = await fetchFromNorg(env, keySuffix, headers);
  if (response) return serveMirror(cfRequest, response, env, url, keySuffix);
  // A refused install changes nothing, this request included: no strip.
  if (refused) return PASSTHROUGH;
  return serveStrippedOrigin(cfRequest, request, env);
}

/**
 * Serve the origin, stripped to a token-dense form where possible.
 *
 * If the strip leaves fewer than STRIP_WORD_FLOOR visible words — a
 * client-rendered origin whose real content the strip removes — the stripped
 * page carries less than the origin, so the origin is served untouched. Any
 * origin answer that is not a 200 HTML page is served by passthrough as well,
 * never relayed from here: CloudFront's own fetch carries what the origin
 * expects, and this function's read may not.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view.
 * @param {Object} env Install config.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveStrippedOrigin(cfRequest, request, env) {
  if (binding(env, "STRIP_FALLBACK_ENABLED") === "false") return PASSTHROUGH;

  const origin = await fetchOrigin(cfRequest, request, MIRROR_FETCH_TIMEOUT_MS);
  if (!origin) return PASSTHROUGH;

  const contentType = origin.headers.get("content-type") || "";
  if (origin.status !== 200 || !/text\/html/i.test(contentType)) return PASSTHROUGH;

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
 * 404, and no render is enqueued — this surface serves what NORG has built.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @param {string} prefix Configured agentic prefix.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveAgenticPath(cfRequest, request, env, url, prefix) {
  const innerPath = url.pathname.slice(prefix.length) || "/";
  const keySuffix = pathToKeySuffix(innerPath);
  const headers = visitHeaders(
    request, env, anonymousClassification(), "agentic_path", "agentic_path_miss", false,
  );
  const { response } = await fetchFromNorg(env, keySuffix, headers);
  if (!response) return PASSTHROUGH;
  return serveMirror(cfRequest, response, env, url, keySuffix);
}

/**
 * Serve the mirror for a ?agent=true override, bypassing UA/IP classification.
 *
 * Traditional search engines never reach here — the floor runs first — so this
 * cannot cloak. Unlike a genuine bot miss, NO render is enqueued: param-driven
 * demo/QA traffic must not trigger renders across the catalogue.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
async function serveAgentOverride(cfRequest, request, env, url) {
  const keySuffix = pathToKeySuffix(url.pathname);
  const headers = visitHeaders(
    request, env, agentOverrideClassification(),
    "agent_param_override", "agent_param_override_miss", false,
  );
  const { response } = await fetchFromNorg(env, keySuffix, headers);
  if (!response) return PASSTHROUGH;
  return serveMirror(cfRequest, response, env, url, keySuffix);
}

/**
 * The NORG-owned surfaces, served before any classification.
 *
 * Split out of handleRequest so the pipeline below reads as the sequence of
 * decisions it is. Each of these is served to every caller from identical
 * bytes, which is exactly why none of them is a cloaking surface.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Request} request Request view.
 * @param {Object} env Install config.
 * @param {URL} url Parsed request URL.
 * @returns {Promise<?(Response|Object)>} Result, or null when none applies.
 */
async function serveNorgOwnedSurface(cfRequest, request, env, url) {
  const pathname = url.pathname;

  if (isMcpPath(pathname)) {
    return (await handleMcp(request, env, url)) || PASSTHROUGH;
  }
  if (isDiscoveryPath(pathname)) {
    return serveOriginFirstArtifact(cfRequest, request, env, url, false);
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
 * Report a human passthrough, entirely off the visitor's path.
 *
 * Opt-in, and best-effort by design: the fast path never fetched the site
 * key, so the key is read and the event sent in one un-awaited chain that the
 * freezing container may drop. A human is never made to wait for it.
 *
 * @param {Object} env Install config.
 * @param {Request} request Incoming request.
 * @returns {void}
 */
function reportHumanPassthrough(env, request) {
  if (env.EDGE_EVENTS_VERBOSE !== "true") return;
  getSiteKey(env)
    .then((key) => {
      if (key) reportPassthrough({ ...env, NORG_SITE_KEY: key }, request, anonymousClassification());
    })
    .catch(() => {});
}

/**
 * The request pipeline — routing only; each branch delegates.
 *
 * Order is load-bearing. Humans, search crawlers and static assets leave
 * before the site key or the feed is touched, so on this provider — where
 * every page request invokes the function — a person never waits on NORG or
 * AWS. Only a bot-shaped request pays for the lookups.
 *
 * @param {Object} cfRequest CloudFront request object.
 * @param {Object} env Install config.
 * @returns {Promise<Response|Object>} Response, or PASSTHROUGH.
 */
export async function handleRequest(cfRequest, env) {
  const request = toRequest(cfRequest);
  if (isHealthProbe(request, env)) {
    // Fetch before answering: the cached verdict starts unentitled, so a probe
    // on a cold isolate reported entitled:false for a site NORG would serve.
    await getBotFeed(env);
    return healthResponse(env, isEntitled());
  }
  if (isPassthrough(request, env)) return PASSTHROUGH;

  const url = new URL(request.url);
  const userAgent = request.headers.get("user-agent") || "";

  // The human fast path: no secret, no feed, no NORG. A passthrough event is
  // sent only when the install opts in, and even then it is never awaited.
  const exit = fastPathExit(request, url, userAgent);
  if (exit) {
    if (exit === "human") reportHumanPassthrough(env, request);
    return PASSTHROUGH;
  }

  // Entitlement gate. Everything below this line serves NORG content or alters
  // the origin response, so none of it may run until NORG has authenticated
  // this install. Unentitled — refused, or never authenticated and NORG is
  // unreachable — the request is passed through completely untouched.
  // The site key lives in Secrets Manager, not in a header, so it is fetched
  // here, after every cheap exit above and immediately before the first call
  // that needs it. Assigned onto env because core/ reads it there, which
  // keeps every provider's credential handling identical.
  env.NORG_SITE_KEY = await getSiteKey(env);
  if (!env.NORG_SITE_KEY) return PASSTHROUGH;

  // A stale feed is refreshed inline here (no keep-alive on this platform, so
  // a background refresh would be lost when the container freezes). Only
  // bot-shaped requests reach this line, so the wait falls on an agent.
  const feed = await getBotFeed(env);
  if (!feed.entitled) return PASSTHROUGH;

  const owned = await serveNorgOwnedSurface(cfRequest, request, env, url);
  if (owned) return owned;

  // The agentic subtree is answered by URL for every caller — humans, search
  // engines and agents alike get identical bytes — so it runs before the
  // search-engine floor and all classification.
  if (isAgenticPath(url.pathname, feed.agenticPathPrefix)) {
    return serveAgenticPath(cfRequest, request, env, url, feed.agenticPathPrefix);
  }

  // Per-page sibling artifacts are advertised as absolute URLs in the page's
  // own mcp.json, so an MCP client fetches them WITHOUT being a verified bot.
  // The per-route skip covers a page's siblings too: an operator who excluded
  // /about did not agree to serve /about/index.md, which carries the same text.
  if (isSiblingArtifactPath(url.pathname)) {
    if (isSkippedPath(feed, siblingPageOf(url.pathname))) return PASSTHROUGH;
    return serveOriginFirstArtifact(cfRequest, request, env, url, true);
  }

  // Static subresources are never a mirrorable document. Deliberately placed
  // AFTER every NORG-owned surface above, because some of them legitimately end
  // in an extension this set matches.
  if (isStaticAssetPath(url.pathname)) return PASSTHROUGH;

  // The operator marked this exact path to pass through untouched.
  if (isSkippedPath(feed, url.pathname)) return PASSTHROUGH;

  // Search engines see exactly what humans see. Checked before classification
  // so it holds even when the feed is stale, and before the ?agent=true
  // override because that override is ungated: any ?agent=true URL that gets
  // linked or discovered would otherwise be crawlable, and answering a crawler
  // with the NORG render is the cloaking rule 2 forbids. The floor is the one
  // thing nothing overrides.
  if (isTraditionalSearchBot(userAgent)) return PASSTHROUGH;

  if (hasAgentOverride(url)) return serveAgentOverride(cfRequest, request, env, url);

  const classification = classifyAgent(userAgent, feed.patterns);
  if (!classification.is_ai_bot) return PASSTHROUGH;

  // NORG decides which crawlers may be served differently, not this file.
  if (!mayDivert(classification)) return PASSTHROUGH;

  // A spoofable UA is not enough to divert: the source IP must be verified, or
  // a spoofed UA from any IP would harvest the NORG mirror.
  if (!verifiedSource(clientIp(cfRequest), feed.cidrRanges, classification)) {
    return PASSTHROUGH;
  }

  return serveAgent(cfRequest, request, env, url, classification);
}

/**
 * Lambda@Edge origin-request entry point.
 *
 * The try/catch and the watchdog together are the whole safety story. Unlike
 * Cloudflare, where an uncaught error still ends at the origin because the
 * catch calls fetch(request), an exception or a timeout HERE is a 502 on the
 * customer's site. So every exit — success, thrown error, or a pipeline that
 * simply took too long — resolves to either a response or the untouched
 * request.
 *
 * @param {Object} event CloudFront Lambda@Edge event.
 * @returns {Promise<Object>} A CloudFront response or the origin request.
 */
export async function handler(event) {
  const cfRequest = event.Records[0].cf.request;
  // A copy, so a pipeline that mutated the request part-way through cannot leak
  // a half-applied origin switch into the failure path. Seeded with the request
  // itself and taken INSIDE the try: this function's whole job is to never
  // throw, so it must not begin with an unguarded call.
  //
  // ORDER IS LOAD-BEARING. This clone used to be taken before readConfig ran,
  // so it kept every config header — and the two paths that return it (the
  // catch below, and an oversized generated response) forwarded the site key to
  // the customer's origin and into their access logs. The catch is the rule-1
  // safety net, which makes it the path most likely to run when anything is
  // wrong. Every return of it now goes through scrubConfigHeaders as well,
  // because the clone still happens before readConfig if readConfig throws.
  let pristine = cfRequest;

  try {
    scrubConfigHeaders((pristine = structuredClone(cfRequest)));

    const env = readConfig(cfRequest);
    // Rule 3, in CloudFront's shape: core's isConfigured() wants the key on the
    // env, but on this provider the key is not in the config at all — the ARN
    // that leads to it is. Without both, every NORG call would be refused, so
    // the correct behaviour is to do nothing rather than fail slowly on each.
    // Even when doing nothing, the Host header must name the origin: the
    // origin-request policy forwards the viewer's Host, and a virtual-hosted
    // origin (a Cloudflare-fronted site, say) proxies an unknown Host straight
    // back into CloudFront — a loop that ends in a 403 on the whole site.
    if (!env.SITE_ID || !env.NORG_SECRET_ARN) return alignHostToOrigin(cfRequest);

    let watchdog;
    const result = await Promise.race([
      handleRequest(cfRequest, env),
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(PASSTHROUGH), WATCHDOG_MS);
      }),
    ]).finally(() => clearTimeout(watchdog));

    // Nothing is awaited here. The router sends no telemetry of its own — the
    // receptionist records each agent visit from the header on the mirror
    // fetch — so there is no background work to flush and no wait a visitor
    // could pay for it. Lambda@Edge freezes the instant this returns.
    if (result === PASSTHROUGH) return toPassthrough(alignHostToOrigin(cfRequest));

    const response = await toCloudFrontResponse(result);
    // Null means the body will not fit CloudFront's generated-response cap.
    // Degrading to the origin is the correct answer: the visitor gets the
    // customer's real page instead of a 502.
    return response || toPassthrough(alignHostToOrigin(scrubConfigHeaders(pristine)));
  } catch (e) {
    console.error("norg edge router error", e);
    // Same reasoning as the unconfigured exit above: the untouched request
    // still needs the origin's Host, or the safety net itself breaks the site.
    return alignHostToOrigin(scrubConfigHeaders(pristine));
  }
}

export default handler;

// Test-only exports.
export {
  // Re-exported so the BUNDLE's own copy of the secret cache can be primed:
  // the built .cjs is a separate module instance, so priming the source module
  // does not reach it, and no test may call Secrets Manager.
  __primeSecretCache as __test_primeSecretCache,
  isHealthProbe as __test_isHealthProbe,
  isPassthrough as __test_isPassthrough,
  serveStrippedOrigin as __test_serveStrippedOrigin,
  MAX_INLINE_MIRROR_BYTES as __test_MAX_INLINE_MIRROR_BYTES,
  WATCHDOG_MS as __test_WATCHDOG_MS,
};
