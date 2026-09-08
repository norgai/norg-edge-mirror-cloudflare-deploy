/**
 * Path predicates deciding which surface owns a request.
 *
 * @description Pure path tests, ported verbatim from the Cloudflare worker.
 *
 * Every function here is a pure string test with no provider-specific
 * behaviour, so each is a direct port. They are grouped in one module because
 * the ORDER they are applied in — in the router's pipeline — is what makes the
 * routing safe, and keeping the tests together makes that order reviewable.
 */

import {
  OPENAI_FEED_PATHS,
  RESERVED_NORG_PREFIX,
  SIBLING_ARTIFACT_FILENAMES,
  STATIC_ASSET_SUFFIXES,
  TRADITIONAL_SEARCH_BOTS,
} from "./constants.mjs";

/**
 * Is this an exact discovery-artifact path?
 *
 * Discovery infrastructure served to EVERY caller at a fixed URL — so only
 * these exact paths match, never a customer page that merely ends in the same
 * name.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for the five exact discovery-artifact paths.
 */
export function isDiscoveryPath(pathname) {
  return (
    pathname === "/llms.txt" ||
    pathname === "/llms-full.txt" ||
    pathname === "/tree.json" ||
    pathname === "/graph.jsonld" ||
    pathname === "/agents.md"
  );
}

/**
 * Is this a per-page sibling artifact?
 *
 * Matched by filename in ANY directory, since every mirrored route publishes
 * its own set.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for a sibling artifact filename.
 */
export function isSiblingArtifactPath(pathname) {
  return SIBLING_ARTIFACT_FILENAMES.has(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * The page a sibling artifact belongs to: "/about/index.md" -> "/about".
 *
 * @param {string} pathname Sibling artifact pathname.
 * @returns {string} The owning page's path.
 */
export function siblingPageOf(pathname) {
  return pathname.slice(0, pathname.lastIndexOf("/")) || "/";
}

/**
 * Is this a reserved NORG asset path (/.norg/*)?
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True when under the reserved prefix.
 */
export function isReservedNorgPath(pathname) {
  return pathname.startsWith(RESERVED_NORG_PREFIX);
}

/**
 * Is this one of the three site-level OpenAI feed artifact paths?
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for ai-plugin.json / openapi.json / openapi.yaml.
 */
export function isOpenAiFeedPath(pathname) {
  return OPENAI_FEED_PATHS.has(pathname);
}

/**
 * Is this an MCP surface path?
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True for MCP endpoints.
 */
export function isMcpPath(pathname) {
  return (
    pathname === "/.well-known/mcp.json" ||
    pathname.endsWith("/mcp") ||
    pathname.endsWith("/sse")
  );
}

/**
 * Is this a path NORG owns and serves itself, before any classification?
 *
 * The four pure read-and-serve surfaces. Each is served to EVERY caller from
 * identical bytes, emits no crawler-visit event and triggers no render — which
 * is why a HEAD may be answered from them. The agentic subtree is deliberately
 * NOT here: it heartbeats and can drive a render, so it keeps GET-only
 * semantics.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True when this router, not the origin, owns the path.
 */
export function isNorgOwnedArtifactPath(pathname) {
  return (
    isMcpPath(pathname) ||
    isDiscoveryPath(pathname) ||
    isReservedNorgPath(pathname) ||
    isOpenAiFeedPath(pathname)
  );
}

/**
 * Is this pathname a static subresource rather than a document request?
 *
 * Reads the extension of the LAST path segment only, so a dot in a directory
 * ("/v1.2/page") is not mistaken for one. Ambiguous shapes deliberately answer
 * false: a missed asset costs the wasted lookups this check exists to avoid,
 * but a document wrongly called an asset is never mirrored at all — so the
 * cheaper mistake is the one to make.
 *
 * @param {string} pathname Request pathname (never includes the query string).
 * @returns {boolean} True when the request is for a static asset.
 */
export function isStaticAssetPath(pathname) {
  const lastSlash = pathname.lastIndexOf("/");
  const segment = lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
  const dot = segment.lastIndexOf(".");
  // No dot, leading-dot dotfile, or trailing dot: not an extension we know.
  if (dot <= 0 || dot === segment.length - 1) return false;
  return STATIC_ASSET_SUFFIXES.has(segment.slice(dot).toLowerCase());
}

/**
 * Normalise a request pathname to the stored EdgeRoute.path form.
 *
 * Guaranteed leading "/", internal repeated slashes collapsed, and no trailing
 * slash except root — mirroring the backend's paths.normalise_path, so a
 * "/a//b" request matches the stored "/a/b".
 *
 * @param {string} pathname url.pathname (always starts with "/").
 * @returns {string} The normalised path.
 */
export function normaliseSkipPath(pathname) {
  if (pathname.length <= 1) return pathname;
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.replace(/\/+$/, "") || "/";
}

/**
 * Has the operator marked this page to pass through to the origin?
 *
 * One implementation for both callers — the page itself and a sibling
 * artifact's owning page — so the two can never disagree about what "skipped"
 * means.
 *
 * @param {Object} feed Bot-pattern feed (carries skipPaths).
 * @param {string} pathname Path to test, in request form.
 * @returns {boolean} True when this path is excluded from the mirror.
 */
export function isSkippedPath(feed, pathname) {
  return Boolean(feed.skipPaths && feed.skipPaths.includes(normaliseSkipPath(pathname)));
}

/**
 * Is this a traditional search-engine crawler that must see the origin?
 *
 * @param {string} userAgent Raw User-Agent header.
 * @returns {boolean} True for web-index crawlers where cloaking is a risk.
 */
export function isTraditionalSearchBot(userAgent) {
  const ua = (userAgent || "").toLowerCase();
  return TRADITIONAL_SEARCH_BOTS.some((bot) => ua.includes(bot));
}

/**
 * Does this request carry the ?agent=true force-serve override?
 *
 * Deliberately an OPEN bypass — no session, token, or workspace gating.
 * SECURITY TENSION: this is a separate, intentional door around the UA+IP
 * verification. If it ever needs revisiting, the fix is to add gating HERE, not
 * to change verifiedSource(). Matched strictly against the lowercase literal
 * "true" so it stays predictable.
 *
 * It does NOT open the traditional-search-engine floor: the floor runs first in
 * the pipeline, so a linked or crawled ?agent=true URL cannot serve Googlebot
 * the render, which would be cloaking.
 *
 * @param {URL} url Parsed request URL.
 * @returns {boolean} True when ?agent=true is present.
 */
export function hasAgentOverride(url) {
  return url.searchParams.get("agent") === "true";
}
