/**
 * Per-platform route exclusions — paths the router must never be invoked for.
 *
 * @description Framework asset prefixes carved out of the router's scope.
 *
 * These are a COPY of content-craft's `route_scope.py` platform lists, for the
 * same reason `constants.mjs` copies the worker's tables: this repository ships
 * standalone and cannot import Python. `aws/tests/exclusions.test.mjs` pins the
 * literals so a silent edit is caught.
 *
 * WHY THIS EXISTS AT ALL. Cloudflare already solves this: every stored
 * exclusion becomes a *no-worker route*, so "the worker is never invoked for it
 * (and never billed)" — install_exclusion_routes.py. A CloudFront cache
 * behaviour carrying no Lambda association is exactly the same mechanism, so
 * the two providers carve out the same paths for the same reason, from the same
 * list, and only the enforcement differs.
 *
 * Selection is not this file's job. content-craft detects the platform
 * (install_preflight._is_nextjs_vercel and friends), stores the result on
 * edge_sites.route_exclusions, and dispatches through
 * route_scope.default_exclusions_for. The set below is the template DEFAULT for
 * a hand-run install; an installer should pass the site's stored exclusions
 * instead.
 */

/** Next.js on Vercel — route_scope.NEXTJS_VERCEL_ROUTE_EXCLUSIONS. */
export const NEXTJS_VERCEL_ROUTE_EXCLUSIONS = ["/_next/*", "/_vercel/*"];

/** Shopify (Online Store 2.0) — route_scope.SHOPIFY_ROUTE_EXCLUSIONS. */
export const SHOPIFY_ROUTE_EXCLUSIONS = [
  "/cdn/*",
  "/.well-known/shopify/*",
  "/recommendations/*",
  "/checkouts/*",
  "/services/*",
  "/web-pixels*",
  "/api/*",
  "/cdn-cgi/*",
  "/cart.js",
  "/shopify_pay/*",
];

/** WordPress — the identifying subset, route_scope.WORDPRESS_EXCLUSION_SIGNATURE. */
export const WORDPRESS_EXCLUSION_SIGNATURE = ["/wp-content/*", "/wp-includes/*"];

/**
 * What the CloudFormation templates generate behaviours for by default.
 *
 * Next.js/Vercel, because it is the common case for a site that would front
 * itself with CloudFront at all. Other platforms are supported by passing the
 * site's own exclusions; they are not a different code path.
 */
export const DEFAULT_ROUTE_EXCLUSIONS = NEXTJS_VERCEL_ROUTE_EXCLUSIONS;

/**
 * Paths NORG serves itself, which an exclusion must never shadow.
 *
 * Mirrors route_scope.protected_patterns_for. On Cloudflare a no-worker route
 * that covered one of these would silently switch off MCP, discovery or the
 * agentic subtree; on CloudFront a cache behaviour would do the same, because
 * behaviours are matched in order and the first match wins. Enforced at build
 * time by aws/build.mjs.
 */
export const PROTECTED_PATH_PREFIXES = [
  "/mcp",
  "/sse",
  "/.well-known/",
  "/openapi.json",
  "/openapi.yaml",
  "/llms.txt",
  "/llms-full.txt",
  "/agents.md",
  "/tree.json",
  "/graph.jsonld",
  "/.norg/",
  "/ai/",
];

/**
 * Highest-volume asset suffixes, for attaching to a distribution we do not own.
 *
 * A new distribution gets a behaviour for every entry in STATIC_ASSET_SUFFIXES,
 * because we own its 75-behaviour budget. Attaching spends the CUSTOMER's
 * budget, so it takes the head of the distribution instead: these ten cover the
 * overwhelming majority of asset requests on a typical site, and the long tail
 * (.docx, .7z, .flac) still passes through correctly — it just costs an
 * invocation, which is the trade the customer's budget is worth.
 */
export const CURATED_ASSET_SUFFIXES = [
  ".js", ".css", ".woff2", ".png", ".jpg", ".svg", ".webp", ".ico", ".mp4", ".pdf",
];

/** CloudFront's per-distribution cache-behaviour quota, default. */
export const CLOUDFRONT_BEHAVIOUR_QUOTA = 75;
