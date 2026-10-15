/**
 * NORG Edge Router for Vercel — Next.js entry point.
 *
 * Typed structurally rather than against `next/server`, so the package works
 * with any Next.js version without a type dependency: a NextRequest is a
 * Request, and a NextFetchEvent has waitUntil.
 */

import type { NorgEdgeOptions, WaitUntilContext } from "./index.js";

export type { NorgEdgeOptions, WaitUntilContext } from "./index.js";

/** The shape of a Next.js middleware (or Next.js 16 proxy) function. */
export type MiddlewareLike<Req extends Request, Ev, Res> = (
  request: Req,
  event: Ev,
) => Res | Promise<Res>;

/** Wrap the application's own middleware: NORG runs first, then yours. */
export declare function withNorgEdge<Req extends Request, Ev extends WaitUntilContext, Res>(
  middleware?: MiddlewareLike<Req, Ev, Res>,
  options?: NorgEdgeOptions,
): (request: Req, event: Ev) => Promise<Res | Response | undefined>;

/** The NORG edge router as a complete middleware, for an app with none of its own. */
export declare function norgEdgeMiddleware(
  options?: NorgEdgeOptions,
): (request: Request, event?: WaitUntilContext) => Promise<Response | undefined>;

/** The router version this package reports to NORG. */
export declare const version: string;
