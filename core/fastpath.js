/**
 * The fast path: who leaves before any lookup, and why.
 *
 * @description One answer for every adapter that runs on each page request.
 *
 * On a platform where the router is invoked for every page request, the cost
 * of a lookup lands on a person unless the router answers them first. This
 * module is that answer, shared so the three adapters cannot drift: a static
 * asset, a traditional search crawler and an ordinary browser on an ordinary
 * page are passed through with no secret, no feed and no NORG call. Anything
 * that might be an agent — a bot-shaped user agent, a Web Bot Auth signature,
 * the ?agent=true override — runs the real sequence.
 *
 * Paths NORG answers by URL for every caller (the discovery artifacts, the
 * agentic subtree, per-page siblings, the MCP surface) never take the fast
 * path: a human there still needs the feed to decide entitlement.
 */

import { isAgenticPath } from "../workers/lib/r2-content.mjs";
import { knownAgenticPathPrefix } from "./feed.js";
import {
  hasAgentOverride,
  hasSignatureHeaders,
  isNorgOwnedArtifactPath,
  isOrdinaryBrowser,
  isSiblingArtifactPath,
  isStaticAssetPath,
  isTraditionalSearchBot,
} from "./paths.js";

/**
 * Is this a path NORG may answer by URL, for every caller?
 *
 * The agentic prefix is the one the container last learned; on a cold
 * container that is the default, which is rule-1 safe — a custom-prefix path
 * on a cold container gets the origin, not an error.
 *
 * @param {string} pathname Request pathname.
 * @returns {boolean} True when the router, not the origin, may own the path.
 */
export function isNorgSurface(pathname) {
  return (
    isNorgOwnedArtifactPath(pathname) ||
    isSiblingArtifactPath(pathname) ||
    isAgenticPath(pathname, knownAgenticPathPrefix())
  );
}

/**
 * Why this request leaves before any lookup, or null to run the sequence.
 *
 * @param {Request} request Incoming request (visitor-facing URL).
 * @param {URL} url Parsed request URL.
 * @param {string} userAgent Raw User-Agent header.
 * @returns {?("static"|"search"|"human")} The exit, or null.
 */
export function fastPathExit(request, url, userAgent) {
  if (isNorgSurface(url.pathname)) return null;
  if (isStaticAssetPath(url.pathname)) return "static";
  if (isTraditionalSearchBot(userAgent)) return "search";
  const plainHuman =
    isOrdinaryBrowser(userAgent) && !hasAgentOverride(url) && !hasSignatureHeaders(request);
  return plainHuman ? "human" : null;
}
