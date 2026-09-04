/**
 * Constant tables shared with the Cloudflare edge-router worker.
 *
 * @description Provider-neutral constants for the CloudFront edge router.
 *
 * These are a deliberate COPY of the declarations in
 * `workers/edge-router-worker.js`, not an import. The Cloudflare worker's
 * bundle is pinned by SHA-256 in content-craft and its EDGE_SCRIPT_VERSION is
 * matched against a backend setting, so refactoring shared values out of that
 * file would change the shipped bundle and tell every installed Cloudflare site
 * an update is available until the backend catches up. Copying costs nothing at
 * runtime; the divergence risk is closed instead by
 * `aws/tests/constants-parity.test.mjs`, which compares the declaration text in
 * both files and fails on any drift.
 *
 * Keep every declaration below BYTE-IDENTICAL to its counterpart (modulo the
 * `export ` prefix) or that test will fail.
 */

// Baked binding defaults (EDGEPAR 04). Five bindings never vary across manual
// and deploy-button installs, so they default here and a hand install only
// needs SITE_ID + the NORG_SITE_KEY secret. An explicitly-bound value still
// overrides its default (see `binding`); EDGE_ENV deliberately has NO default —
// "unknown" is its fallback and the guards refuse to manage an unnamed env.
export const BINDING_DEFAULTS = {
  NORG_API_URL: "https://content-craft-api.norg.ai",
  NORG_CONTENT_BASE: "https://edge-content.norg.ai",
  STRIP_FALLBACK_ENABLED: "true",
  EDGE_DISABLED: "false",
  LAZY_RENDER_ENABLED: "true",
};

// Budgets. The origin is always the fallback, so a slow NORG must cost the
// visitor a few hundred ms at worst, never a failed page.
export const MIRROR_FETCH_TIMEOUT_MS = 4000;
export const PATTERN_FETCH_TIMEOUT_MS = 5000;
export const CONTROL_CALL_TIMEOUT_MS = 3000;
export const MCP_FORWARD_TIMEOUT_MS = 3000;

// Fallback response-cache TTL (seconds) if the feed omits one.
export const RESPONSE_CACHE_DEFAULT_TTL_SECONDS = 300;

export const PATTERN_DEFAULT_TTL_MS = 3600 * 1000;

// A refused (401/403) or unreachable-with-nothing-cached install is
// negative-cached for this short window, so a paused site costs its visitors
// no blocking NORG probe on every request. Kept short so re-entitlement lands
// within a minute: after it expires one request re-probes and a 200 feed
// restores full behaviour.
export const UNENTITLED_TTL_MS = 60 * 1000;

// Heartbeats piggyback on traffic so a site with a broken cron still reports
// in; this is the floor between traffic-driven beats per isolate.
export const HEARTBEAT_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Suppresses repeat render requests for the same cold path within an isolate.
// Only an optimisation — NORG dedups authoritatively — so a small bounded map
// is enough, and it must never grow without limit.
export const RENDER_DEDUP_TTL_MS = 10 * 60 * 1000;
export const RENDER_DEDUP_MAX_ENTRIES = 500;

// Below this many visible words after stripping, the stripped page carries
// less than the origin (measured: a client-rendered origin whose content is a
// newsletter + footer strips to near-empty). Serve the untouched origin as
// "origin_thin" instead — a real page beats a page with its content removed.
export const STRIP_WORD_FLOOR = 120;

/**
 * Traditional web-index crawlers, matched on user-agent and always passed
 * through to the origin.
 *
 * This is deliberately an operator list and NOT `purpose === "search"`. In
 * ai_bot_patterns that purpose covers both Googlebot/Bingbot — where serving
 * different content is cloaking and risks the customer's rankings — and AI
 * answer engines like PerplexityBot and OAI-SearchBot, which are precisely
 * the agents this product exists to serve. Keying on purpose would silently
 * exclude the target market.
 *
 * Note "google-extended" (Google's AI crawler) does not contain "googlebot",
 * so it is served like any other AI agent.
 */
export const TRADITIONAL_SEARCH_BOTS = [
  "googlebot",
  "bingbot",
  "applebot",
  "duckduckbot",
  "baiduspider",
  "yandex",
  "slurp",
];

/**
 * There is deliberately NO hardcoded fallback pattern set.
 *
 * A local list would be exactly the loophole the entitlement gate exists to
 * close: an install whose key NORG has revoked, or which never authenticated at
 * all, would keep classifying and diverting from a stale copy baked into the
 * script. Bot detection is NORG's to publish and to withdraw, so an install
 * that cannot obtain an authenticated feed does nothing at all.
 */
export const UNENTITLED = Object.freeze({
  entitled: false,
  patterns: [],
  cidrRanges: {},
  agenticPathPrefix: "",
  skipPaths: [],
});

// Used only if NORG somehow omits the field; the column's own default.
export const DEFAULT_AGENTIC_PATH_PREFIX = "/ai";

// NORG answering with one of these is a decision, not an outage: the key is
// wrong, or the site is paused/uninstalled (site_auth.py returns 401 and 403
// respectively). Cached entitlement is dropped immediately on either.
export const REFUSAL_STATUSES = new Set([401, 403]);

/** Elements with no informational value to an agent. */
export const STRIP_REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "video",
  "audio",
  "form",
  "input",
  "select",
  "textarea",
  "nav",
  "aside",
  "footer",
  "link[rel='stylesheet']",
  "link[rel='preload']",
  "link[rel='prefetch']",
  "[role='navigation']",
  "[aria-hidden='true']",
];

// Wrapper-only elements: the tag itself carries no informational value, but
// (unlike STRIP_REMOVE_SELECTORS) its text content often does — accordion/
// nav toggles routinely wrap a real label in a <button> (live example:
// gymshark.com's mobile menu — <h5><button><span>Trending</span></button></h5>).
// Remove the wrapper, keep its content.
export const STRIP_UNWRAP_SELECTORS = ["button"];

/** Attributes carrying styling/behaviour rather than meaning. */
export const STRIP_KEEP_ATTRIBUTES = new Set([
  "href",
  "src",
  "alt",
  "title",
  "lang",
  "datetime",
  "content",
  "name",
  "rel",
]);
