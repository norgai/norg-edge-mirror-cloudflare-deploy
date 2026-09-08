/**
 * Shared harness for the Bunny router suites.
 *
 * @description Builds Bunny middleware requests and routes a stubbed fetch.
 *
 * The shape being modelled is the one a live pull zone actually produced on
 * 2026-09-07: `onOriginRequest` receives a Request whose URL is already
 * pointed at the ORIGIN, while the visitor's hostname survives in `cdn-host`
 * and the client address in `x-real-ip` / `x-forwarded-for`.
 */

export const SITE_ID = "site-1";
export const SITE_KEY = "nek_live_testkey";
export const CONTENT_BASE = "https://edge-content.test.norg.ai";
export const API_URL = "https://api.test.norg.ai";
export const ORIGIN_HOST = "origin.example.com";
export const PUBLIC_HOST = "shop.example.com";

export const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";
export const GPTBOT_UA = "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)";
export const GOOGLEBOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
export const GOOGLE_EXTENDED_UA = "Mozilla/5.0 (compatible; Google-Extended/1.0)";

// An OpenAI-published range, and an address inside it.
export const VERIFIED_IP = "20.171.5.9";
export const UNVERIFIED_IP = "8.8.8.8";

export const FEED = {
  patterns: [
    { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
    {
      pattern: "google-extended",
      company: "google",
      purpose: "training",
      serving_policy: "divert",
    },
    {
      pattern: "ccbot",
      company: "commoncrawl",
      purpose: "training",
      serving_policy: "never_divert",
    },
    // Deliberately shares OpenAI's verified range: this crawler would pass the
    // source-IP gate, so a test using it isolates the serving-policy gate.
    { pattern: "heldbot", company: "heldco", purpose: "training", serving_policy: "never_divert" },
  ],
  cidr_ranges: {
    openai: { cidrs: ["20.171.0.0/16"] },
    google: { cidrs: ["20.171.0.0/16"] },
    heldco: { cidrs: ["20.171.0.0/16"] },
  },
  agentic_path_prefix: "/ai",
  skip_paths: ["/checkout"],
  content_version: "1730000000",
  response_cache: { enabled: false, ttl: 300 },
  cache_ttl: 3600,
};

/** Install config in the shape lib/config.js produces. */
export const ENV = {
  SITE_ID,
  NORG_SITE_KEY: SITE_KEY,
  NORG_API_URL: API_URL,
  NORG_CONTENT_BASE: CONTENT_BASE,
  EDGE_ENV: "test",
  EDGE_PLATFORM: "bunny",
  EDGE_SCRIPT_VERSION: "0.1.2",
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
 * Build the Request Bunny hands `onOriginRequest`.
 *
 * @param {Object} options Request shape.
 * @returns {Request} An origin-pointed request with Bunny's CDN headers.
 */
export function bunnyRequest({
  path = "/widgets/",
  method = "GET",
  headers = {},
  clientIp = VERIFIED_IP,
  visitorHost = PUBLIC_HOST,
  body,
} = {}) {
  const merged = new Headers({
    host: visitorHost,
    "cdn-host": visitorHost,
    "cdn-origin-host": ORIGIN_HOST,
    "cdn-origin-proto": "https",
    "cdn-loopcount": "1",
    "cdn-requestcountrycode": "AU",
    "x-forwarded-for": clientIp,
    "x-forwarded-proto": "https",
    "x-real-ip": clientIp,
  });
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  // The URL Bunny presents is already rewritten to the origin.
  return new Request(`https://${ORIGIN_HOST}${path}`, { method, headers: merged, body });
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
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init, method: (input && input.method) || init.method || "GET" });

    if (url.includes("/api/v1/edge/bot-patterns")) {
      if (feed) return feed(url, init);
      return new Response(JSON.stringify(FEED), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/v1/edge/") || url.includes("/public-mcp")) {
      return control ? control(url, init) : new Response("{}", { status: 200 });
    }
    if (url.startsWith(CONTENT_BASE)) {
      return mirror ? mirror(url, init) : new Response("", { status: 404 });
    }
    if (url.includes(ORIGIN_HOST)) {
      return origin
        ? origin(url, init)
        : new Response(longHtml(), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return { calls };
}

/**
 * A mirror response for the receptionist.
 *
 * @param {string} body Body text.
 * @param {Object} headers Extra headers.
 * @returns {Response} A 200 carrying HTML.
 */
export const mirrorHit = (body = "<html><body>mirror</body></html>", headers = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
