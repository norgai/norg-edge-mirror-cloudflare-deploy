/**
 * NORG Edge Router for Vercel — Next.js entry point.
 *
 * @description withNorgEdge(): wraps (or stands in for) a Next.js middleware.
 *
 * Works in `middleware.ts` (Next.js 13–15) and `proxy.ts` (Next.js 16), on
 * the Edge or the Node.js runtime. NORG runs first; when it has nothing to
 * serve — every human, every search engine, every unverified caller — the
 * application's own middleware runs exactly as before, or, with none, the
 * request continues to the page. Nothing here imports `next`, so the package
 * adds no runtime dependency on any Next.js version.
 */

import { createNorgEdge } from "./index.js";

/**
 * Wrap an existing Next.js middleware with the NORG edge router.
 *
 * @param {Function} [middleware] The application's own middleware.
 * @param {Object} [options] Same options as createNorgEdge.
 * @returns {Function} (request, event) => Promise<Response|undefined>.
 */
export function withNorgEdge(middleware, options) {
  const norgEdge = createNorgEdge(options);
  return async function middlewareWithNorgEdge(request, event) {
    const response = await norgEdge(request, event);
    if (response) return response;
    return typeof middleware === "function" ? middleware(request, event) : undefined;
  };
}

/**
 * The NORG edge router as a complete Next.js middleware, for an app that has
 * none of its own.
 *
 * @param {Object} [options] Same options as createNorgEdge.
 * @returns {Function} (request, event) => Promise<Response|undefined>.
 */
export function norgEdgeMiddleware(options) {
  return withNorgEdge(undefined, options);
}

export { version } from "./index.js";
