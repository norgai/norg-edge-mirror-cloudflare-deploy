/**
 * Reading the customer's own page, for the strip and origin-first artifacts.
 *
 * @description Vercel adapter for origin fetches.
 *
 * Middleware sits in front of the application, so "serve the origin" is not a
 * fetch at all: the handler returns nothing and Vercel carries on to the page
 * exactly as if this package were not installed (see index.js). Only two paths
 * need the origin's BYTES — the strip, which must measure a page before
 * deciding whether stripping it helps, and the origin-first artifacts, which
 * must see whether the site has its own llms.txt — and those fetch the same
 * URL again.
 *
 * That fetch re-enters this middleware. The loop-guard header is what makes
 * the second pass a passthrough (isPassthrough in router.js), so it is set
 * unconditionally here.
 */

import { LOOP_GUARD_HEADER } from "../../../core/constants.mjs";

// The page read an agent waits on before the strip. Matches CloudFront's.
export const ORIGIN_READ_TIMEOUT_MS = 3000;

/**
 * Fetch the customer's own response for this request.
 *
 * Never throws: an unreachable origin resolves to null, and every caller's
 * answer to that is a passthrough (rule 1).
 *
 * @param {Request} request Incoming request.
 * @param {number} [timeoutMs] Abort budget in milliseconds.
 * @returns {Promise<?Response>} Origin response, or null.
 */
export async function fetchOrigin(request, timeoutMs = ORIGIN_READ_TIMEOUT_MS) {
  try {
    const headers = new Headers(request.headers);
    headers.set(LOOP_GUARD_HEADER, "1");
    return await fetch(request.url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    console.error("norg edge origin fetch failed", e);
    return null;
  }
}
