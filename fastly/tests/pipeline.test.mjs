/**
 * The Fastly request pipeline.
 *
 * @description Proves the port makes the Cloudflare worker's decisions.
 *
 * As with CloudFront, the first test is the one that matters most: a real
 * browser user-agent must come back untouched. Fastly's runtime already speaks
 * standard Request/Response, so `handleRequest` is exercised directly — there
 * is no event-shape adapter to mock, which is itself the point of this port.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { handleRequest } from "../src/router.js";
import { __test_setFeed } from "../../core/feed.js";
import { __test_reset as resetDeferred } from "../../core/deferred.js";
import { __test_reset as resetTelemetry } from "../../core/telemetry.js";

const SITE_ID = "site-1";
const KEY = "nek_live_testkey";
const API = "https://api.test.norg.ai";
const CONTENT = "https://edge-content.test.norg.ai";
const ORIGIN_HTML =
  "<!doctype html><html><head><title>T</title><script>var a=1;</script></head>" +
  `<body><nav>menu</nav><h1>Heading</h1><p>${Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")}</p></body></html>`;

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1)";
const VERIFIED_IP = "20.171.5.9";

const FEED = {
  entitled: true,
  patterns: [{ pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" }],
  cidrRanges: { openai: { cidrs: ["20.171.0.0/16", "2001:db8:1::/48"] } },
  agenticPathPrefix: "/ai",
  skipPaths: ["/checkout"],
  responseCache: { enabled: false, ttl: 300 },
  fetchedAt: Date.now(),
  ttl: 3_600_000,
};

const realFetch = globalThis.fetch;
let calls = [];

/**
 * Build an install config with a stubbed backend-aware fetch.
 *
 * @param {Object} overrides Extra config values.
 * @param {Object} responses Handlers for mirror and origin.
 * @returns {Object} Config object.
 */
function makeEnv(overrides = {}, { mirror, origin } = {}) {
  calls = [];
  const env = {
    SITE_ID,
    NORG_SITE_KEY: KEY,
    NORG_API_URL: API,
    NORG_CONTENT_BASE: CONTENT,
    EDGE_ENV: "test",
    EDGE_SCRIPT_VERSION: "0.1.1",
    EDGE_PLATFORM: "fastly",
    ...overrides,
  };
  env.EDGE_FETCH = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith(CONTENT)) {
      return mirror ? mirror() : new Response("", { status: 404 });
    }
    return new Response("{}", { status: 200 });
  };
  // The origin adapter uses global fetch with a backend; stub it here.
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(String(url));
    return origin
      ? origin()
      : new Response(ORIGIN_HTML, { status: 200, headers: { "content-type": "text/html" } });
  };
  return env;
}

/**
 * Run the pipeline for a request.
 *
 * @param {string} path Path with optional query.
 * @param {string} ua User-agent.
 * @param {Object} env Config object.
 * @param {string} ip Client IP.
 * @returns {Promise<Response>} The response.
 */
const run = (path, ua, env, ip = VERIFIED_IP) =>
  handleRequest(new Request(`https://shop.example.com${path}`, { headers: { "user-agent": ua } }), env, ip);

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
  resetDeferred();
  resetTelemetry();
});

test("a real browser gets the origin, with no NORG header", async () => {
  __test_setFeed(FEED);
  const response = await run("/widgets/", CHROME, makeEnv());

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(response.status, 200);
});

test("Googlebot always gets the origin, even with ?agent=true", async () => {
  __test_setFeed(FEED);
  for (const path of ["/widgets/", "/widgets/?agent=true"]) {
    const response = await run(path, GOOGLEBOT, makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) }));
    assert.equal(response.headers.get("x-norg-edge"), null, path);
  }
});

test("a verified AI agent gets the mirror, inline and labelled", async () => {
  // No size branch and no origin switch: unlike CloudFront, Fastly imposes no
  // cap on a generated response, so the headers are always present.
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html><body>NORG render</body></html>", { status: 200, headers: { "content-type": "text/html" } }) });
  const response = await run("/widgets/", GPTBOT, env);

  assert.equal(response.headers.get("x-norg-edge"), "mirror");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-norg-edge-env"), "test");
  assert.match(await response.text(), /NORG render/);
});

test("a spoofed user-agent from an unverified IP is not diverted", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  const response = await run("/widgets/", GPTBOT, env, "8.8.8.8");

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(calls.some((u) => u.startsWith(CONTENT)), false, "no mirror lookup for an unverified source");
});

test("an unentitled install passes everything through", async () => {
  __test_setFeed({ entitled: false, patterns: [], cidrRanges: {}, skipPaths: [], fetchedAt: Date.now(), ttl: 60_000 });
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  const response = await run("/widgets/", GPTBOT, env);

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(calls.some((u) => u.startsWith(CONTENT)), false);
});

test("an unentitled install does not serve NORG-owned surfaces either", async () => {
  // These are matched by PATH, not by classification, so an empty pattern list
  // does not protect them — only the entitlement gate does.
  __test_setFeed({ entitled: false, patterns: [], cidrRanges: {}, skipPaths: [], fetchedAt: Date.now(), ttl: 60_000 });
  for (const path of ["/llms.txt", "/.norg/theme.css", "/openapi.json", "/.well-known/mcp.json"]) {
    const env = makeEnv({}, {
      mirror: () => new Response("norg copy", { status: 200, headers: { "content-type": "text/plain" } }),
      origin: () => new Response("", { status: 404 }),
    });
    const response = await run(path, CHROME, env);

    assert.equal(response.headers.get("x-norg-edge"), null, `${path} was served without entitlement`);
    assert.equal(
      calls.some((u) => u.startsWith(CONTENT)),
      false,
      `${path} hit the receptionist without entitlement`,
    );
  }
});

test("a mirror miss strips the origin and asks NORG to render", async () => {
  __test_setFeed(FEED);
  const response = await run("/widgets/", GPTBOT, makeEnv());

  assert.equal(response.headers.get("x-norg-edge"), "stripped");
  const body = await response.text();
  assert.equal(/<nav>|<script/i.test(body), false, "the strip did not run");
  assert.match(body, /word0/);
});

test("EDGE_DISABLED is a remote off switch", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({ EDGE_DISABLED: "true" });
  const response = await run("/widgets/", GPTBOT, env);

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(calls.some((u) => u.startsWith(CONTENT)), false);
});

test("an operator-skipped path is served from the origin", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  const response = await run("/checkout", GPTBOT, env);
  assert.equal(response.headers.get("x-norg-edge"), null);
});

test("a static asset skips the whole pipeline", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  await run("/assets/app.css", GPTBOT, env);
  assert.equal(calls.some((u) => u.startsWith(CONTENT)), false);
});

test("an authenticated health probe reports the install's state", async () => {
  __test_setFeed(FEED);
  const env = makeEnv();
  const response = await handleRequest(
    new Request("https://shop.example.com/", { headers: { [ "x-norg-edge-check" ]: KEY } }),
    env,
    VERIFIED_IP,
  );
  const body = await response.json();

  assert.equal(body.site_id, SITE_ID);
  assert.equal(body.platform, "fastly");
  assert.equal(body.env, "test");
});

test("?agent=true forces the mirror but enqueues no render", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200, headers: { "content-type": "text/html" } }) });
  const response = await run("/widgets/?agent=true", CHROME, env);

  assert.equal(response.headers.get("x-norg-edge"), "mirror");
  assert.equal(calls.some((u) => u.includes("/render-requests")), false);
});

// --- IPv6 source verification (workers/lib/cidr.mjs via core/agent.js) -------

test("an IPv6 client inside the operator's published IPv6 range gets the mirror", async () => {
  // Fastly, like CloudFront, has no verified-bot fallback: before family-aware
  // matching an IPv6 client was unmeasurable and therefore refused.
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html><body>NORG render</body></html>", { status: 200, headers: { "content-type": "text/html" } }) });
  const response = await run("/widgets/", GPTBOT, env, "2001:db8:1::42");

  assert.equal(response.headers.get("x-norg-edge"), "mirror");
});

test("an IPv6 client outside the operator's IPv6 range is not diverted", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  const response = await run("/widgets/", GPTBOT, env, "2001:db8:2::42");

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(calls.some((u) => u.startsWith(CONTENT)), false, "no mirror lookup for an unverified source");
});
