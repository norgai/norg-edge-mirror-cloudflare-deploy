/**
 * Shared harness for the Vercel adapter suites.
 *
 * @description Builds Vercel-shaped requests and routes a stubbed global fetch.
 */

export const SITE_ID = "site-1";
export const SITE_KEY = "nek_live_testkey";
export const CONTENT_BASE = "https://edge-content.test.norg.ai";
export const API_URL = "https://api.test.norg.ai";
export const PUBLIC_HOST = "shop.example.com";

export const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";
export const GPTBOT_UA = "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)";
export const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// An OpenAI-published range, and an address inside it.
export const VERIFIED_IP = "20.171.5.9";
export const UNVERIFIED_IP = "8.8.8.8";

export const FEED = {
  patterns: [
    { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
    { pattern: "ccbot", company: "commoncrawl", purpose: "training", serving_policy: "never_divert" },
  ],
  cidr_ranges: { openai: { cidrs: ["20.171.0.0/16"] } },
  agentic_path_prefix: "/ai",
  skip_paths: ["/checkout"],
  content_version: "1730000000",
  response_cache: { enabled: false, ttl: 300 },
  cache_ttl: 3600,
};

// Factory options every suite uses: credentials, a test API, and Vercel's
// headers trusted as they would be on a real deployment.
export const OPTIONS = {
  siteId: SITE_ID,
  siteKey: SITE_KEY,
  apiUrl: API_URL,
  contentBase: CONTENT_BASE,
  trustVercelHeaders: true,
};

/**
 * HTML long enough to clear STRIP_WORD_FLOOR after stripping.
 *
 * @param {number} words Number of body words.
 * @returns {string} A document with a nav, a script and `words` real words.
 */
export function longHtml(words = 200) {
  const body = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
  return (
    "<!doctype html><html><head><title>T</title><script>var a=1;</script></head>" +
    `<body><nav>menu items here</nav><h1 class="x">Heading</h1><p>${body}</p>` +
    "<footer>footer</footer></body></html>"
  );
}

/**
 * A request as Vercel delivers it to middleware.
 *
 * @param {Object} options Request shape.
 * @returns {Request} The request.
 */
export function vercelRequest({
  path = "/widgets/",
  method = "GET",
  userAgent = GPTBOT_UA,
  ip = VERIFIED_IP,
  headers = {},
  body,
} = {}) {
  const all = {
    "user-agent": userAgent,
    "x-real-ip": ip,
    "x-forwarded-for": ip,
    "x-vercel-id": "syd1::iad1::abc123-1730000000000-deadbeef",
    "x-vercel-ip-country": "AU",
    "x-vercel-ip-city": "S%C3%A3o%20Paulo",
    ...headers,
  };
  return new Request(`https://${PUBLIC_HOST}${path}`, { method, headers: all, body });
}

/**
 * A context recording what was handed to waitUntil.
 *
 * @returns {{waitUntil: Function, pending: Array<Promise>}} The context.
 */
export function waitUntilContext() {
  const pending = [];
  return { pending, waitUntil: (promise) => pending.push(promise) };
}

/**
 * Install a global fetch stub routing by URL.
 *
 * @param {Object} routes Handlers: feed, mirror, origin, control.
 * @returns {{calls: Array}} Record of every call made.
 */
export function stubNetwork({ feed, mirror, origin, control } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/api/v1/edge/bot-patterns")) {
      return feed ? feed(url, init) : json(FEED);
    }
    if (url.includes("/api/v1/edge/") || url.includes("/public-mcp")) {
      return control ? control(url, init) : json({ status: "ok" });
    }
    if (url.startsWith(CONTENT_BASE)) {
      return mirror ? mirror(url, init) : new Response("", { status: 404 });
    }
    if (url.startsWith(`https://${PUBLIC_HOST}/`)) {
      return origin ? origin(url, init) : html(longHtml());
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return { calls };
}

/**
 * A JSON 200.
 *
 * @param {Object} body Body.
 * @returns {Response} Response.
 */
export const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * An HTML response.
 *
 * @param {string} body Body.
 * @param {number} [status] Status.
 * @returns {Response} Response.
 */
export const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * The decoded X-Norg-Visit document a receptionist fetch carried.
 *
 * @param {Array} calls Recorded fetch calls.
 * @returns {?Object} The document, or null.
 */
export function visitOn(calls) {
  const call = calls.find((c) => c.url.startsWith(CONTENT_BASE));
  const raw = call && new Headers(call.init.headers).get("x-norg-visit");
  return raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : null;
}

/**
 * Only the calls made to NORG (feed, control, receptionist).
 *
 * @param {Array} calls Recorded fetch calls.
 * @returns {Array} NORG calls.
 */
export const norgCalls = (calls) =>
  calls.filter((c) => c.url.startsWith(API_URL) || c.url.startsWith(CONTENT_BASE));
