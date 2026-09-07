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

/**
 * The MCP transport paths, as CloudFront path patterns.
 *
 * Mirrors core/paths.js isMcpPath exactly: the well-known manifest, and any
 * path ending in /mcp or /sse. CloudFront's `*` matches zero or more
 * characters, so `*\/mcp` also matches the bare `/mcp`.
 *
 * WHY THESE GET THEIR OWN BEHAVIOURS. The MCP JSON-RPC transport is the ONE
 * surface that needs the request body — and `IncludeBody` is set per
 * association, not per path. Leaving it on the default behaviour delivered
 * every cache-miss POST body on the site (logins, checkouts, forms) into the
 * router's memory, even though the router discards them. Splitting MCP out
 * lets the default behaviour run with IncludeBody off, so the only bodies the
 * router ever receives are the ones it forwards.
 */
export const MCP_PATH_PATTERNS = ["/.well-known/mcp.json", "*/mcp", "*/sse"];

/**
 * Dynamic, never-mirrorable paths, carved out with NO cache and NO Lambda.
 *
 * Unlike the asset carve-outs these must not be cached at all: a 24 h default
 * TTL on /api or /cart would serve one visitor's response to the next. They
 * therefore use CloudFront's managed CachingDisabled policy and forward
 * everything, so the origin sees exactly what it would have seen without the
 * router — the router is simply never invoked, and never receives a body.
 *
 * Kept deliberately short and unambiguous. `/account*` and `/login*` were
 * considered and left out: they also match marketing slugs like /accounting
 * and /login-help, and a carve-out that silently un-mirrors a real page is the
 * failure this whole module exists to prevent. Trim or extend per site.
 */
export const DYNAMIC_ROUTE_EXCLUSIONS = [
  "/api/*",
  "/wp-json/*",
  "/wp-admin/*",
  "/wp-login.php",
  "/cart",
  "/cart/*",
  "/checkout",
  "/checkout/*",
];

/**
 * CloudFront's managed policies for the dynamic carve-outs. Managed ids are
 * global constants published by AWS, identical in every account.
 */
export const MANAGED_CACHING_DISABLED_ID = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
export const MANAGED_ALL_VIEWER_ORIGIN_REQUEST_ID = "216adef6-5c7f-47e4-b989-5492eafa07d3";

/**
 * The asset suffixes the NEW-distribution template carves out.
 *
 * A strict subset of STATIC_ASSET_SUFFIXES, and the router still recognises
 * every one of the full list — a suffix absent here simply costs an invocation
 * and is passed through, never mis-served. The subset exists for a byte
 * budget, not a behaviour budget: CloudFormation refuses a template body over
 * 51,200 bytes, and each behaviour is ~300. The nineteen left out (.tiff,
 * .heic, .bmp, .avi, .mkv, .m4v, .ogv, .aac, .flac, .weba, .vtt, .srt, .doc,
 * .xls, .ppt, .rar, .tar, .7z, .eot) are the ones a marketing site serves
 * least. aws/build.mjs enforces the byte limit.
 */
export const TEMPLATE_ASSET_SUFFIXES = [
  ".css", ".js", ".mjs", ".map",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif",
  ".woff", ".woff2", ".ttf", ".otf",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a",
  ".pdf", ".docx", ".xlsx", ".pptx", ".zip", ".gz", ".webmanifest",
];

/** CloudFront's per-distribution cache-behaviour quota, default. */
export const CLOUDFRONT_BEHAVIOUR_QUOTA = 75;
