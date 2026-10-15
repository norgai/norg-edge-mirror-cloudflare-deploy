/**
 * NORG Edge Router for Vercel — framework-neutral entry point.
 */

/** Anything with Vercel's waitUntil: a Vercel request context or a NextFetchEvent. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface NorgEdgeOptions {
  /** NORG Site ID. Defaults to the NORG_SITE_ID environment variable. */
  siteId?: string;
  /** NORG Site Key. Defaults to NORG_SITE_KEY. Keep it in a Sensitive variable. */
  siteKey?: string;
  /** NORG API base. Defaults to NORG_API_URL, then NORG production. */
  apiUrl?: string;
  /** NORG render base. Defaults to NORG_CONTENT_BASE, then NORG production. */
  contentBase?: string;
  /** "production" | "test". Defaults to NORG_EDGE_ENV, else derived from apiUrl. */
  env?: string;
  /** Kill switch: every request goes to the site. Defaults to NORG_EDGE_DISABLED. */
  disabled?: boolean;
  /** Serve unrendered pages to agents stripped to their text. Default true. */
  stripFallback?: boolean;
  /** Ask NORG to render pages agents request. Default true. */
  lazyRender?: boolean;
  /**
   * Reads the visitor's IP. Only needed off Vercel: on Vercel the platform's
   * own x-real-ip is used. Off Vercel without this, no agent is verified.
   */
  getClientIp?: (request: Request) => string | null | undefined;
}

/** Resolves to a Response when NORG answers, or undefined to continue to the site. */
export type NorgEdgeHandler = (
  request: Request,
  context?: WaitUntilContext,
) => Promise<Response | undefined>;

/** Create the NORG edge handler. Use it as Vercel Routing Middleware as-is. */
export declare function createNorgEdge(options?: NorgEdgeOptions): NorgEdgeHandler;

/** The router version this package reports to NORG. */
export declare const version: string;

export default createNorgEdge;
