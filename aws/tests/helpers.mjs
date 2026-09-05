/**
 * Shared harness for the CloudFront router suites.
 *
 * @description Builds Lambda@Edge events and routes a stubbed global fetch.
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
export const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// An OpenAI-published range, and an address inside it.
export const VERIFIED_IP = "20.171.5.9";
export const UNVERIFIED_IP = "8.8.8.8";
// IPv6 counterparts: inside / outside the v6 range the feed publishes for openai.
export const VERIFIED_IPV6 = "2001:db8:1::42";
export const UNVERIFIED_IPV6 = "2001:db8:2::42";

export const FEED = {
  patterns: [
    { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
    { pattern: "ccbot", company: "commoncrawl", purpose: "training", serving_policy: "never_divert" },
    // Deliberately shares OpenAI's verified range: this crawler would pass the
    // source-IP gate, so a test using it isolates the serving-policy gate from
    // the one after it. Without that, removing mayDivert() is invisible.
    { pattern: "heldbot", company: "heldco", purpose: "training", serving_policy: "never_divert" },
  ],
  cidr_ranges: {
    openai: { cidrs: ["20.171.0.0/16", "2001:db8:1::/48"] },
    heldco: { cidrs: ["20.171.0.0/16"] },
  },
  agentic_path_prefix: "/ai",
  skip_paths: ["/checkout"],
  content_version: "1730000000",
  response_cache: { enabled: false, ttl: 300 },
  cache_ttl: 3600,
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
 * Build a Lambda@Edge origin-request event.
 *
 * @param {Object} options Request shape and install config.
 * @returns {Object} A CloudFront event.
 */
export function cloudFrontEvent({
  uri = "/widgets/",
  method = "GET",
  headers = {},
  querystring = "",
  clientIp = VERIFIED_IP,
  config = {},
} = {}) {
  const requestHeaders = { host: [{ key: "Host", value: PUBLIC_HOST }] };
  for (const [key, value] of Object.entries(headers)) {
    requestHeaders[key.toLowerCase()] = [{ key, value }];
  }

  const installConfig = {
    "x-norg-site-id": SITE_ID,
    "x-norg-site-key": SITE_KEY,
    "x-norg-api-url": API_URL,
    "x-norg-content-base": CONTENT_BASE,
    "x-norg-env": "test",
    ...config,
  };
  const customHeaders = {};
  for (const [key, value] of Object.entries(installConfig)) {
    if (value !== undefined) customHeaders[key] = [{ key, value }];
  }

  return {
    Records: [
      {
        cf: {
          config: { distributionId: "E123", eventType: "origin-request", requestId: "r1" },
          request: {
            clientIp,
            method,
            uri,
            querystring,
            headers: requestHeaders,
            origin: {
              custom: {
                domainName: ORIGIN_HOST,
                port: 443,
                protocol: "https",
                path: "",
                sslProtocols: ["TLSv1.2"],
                readTimeout: 30,
                keepaliveTimeout: 5,
                customHeaders,
              },
            },
          },
        },
      },
    ],
  };
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
    calls.push({ url, init, body: init.body });

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
 * @returns {Response} A 200 with a content-length.
 */
export const mirrorHit = (body = "<html><body>mirror</body></html>", headers = {}) =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
  });

/**
 * Did the router hand the request back to CloudFront untouched?
 *
 * @param {Object} result Handler result.
 * @returns {boolean} True for a passthrough.
 */
export const isPassthroughResult = (result) => typeof result.status !== "string";

/**
 * Read a header from a CloudFront response object.
 *
 * @param {Object} response CloudFront response.
 * @param {string} name Lower-cased header name.
 * @returns {?string} Header value, or null.
 */
export const header = (response, name) => response.headers?.[name]?.[0]?.value ?? null;
