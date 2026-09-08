/**
 * The Fastly request pipeline.
 *
 * @description Proves the port makes the Cloudflare worker's decisions.
 *
 * As with CloudFront, the first test is the one that matters most: a real
 * browser user-agent must come back untouched — and, since 0.2.0, without a
 * single call to NORG. Fastly's runtime already speaks standard
 * Request/Response, so `handleRequest` is exercised directly; there is no
 * event-shape adapter to mock, which is itself the point of this port.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { handleRequest } from "../src/router.js";
import { originFetchInit } from "../src/lib/origin.js";
import { __test_getFeed, __test_setFeed } from "../../core/feed.js";

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

// Stands in for the CacheOverride("pass") index.js builds; the router only
// ever passes it through, so identity is all the assertions need.
const PASS = Object.freeze({ mode: "pass" });

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
 * NORG calls go through EDGE_FETCH, exactly as index.js wires them; origin
 * calls go through global fetch with a backend, as lib/origin.js makes them.
 * Both are recorded with their init so headers and cache overrides can be
 * asserted.
 *
 * @param {Object} overrides Extra config values.
 * @param {Object} responses Handlers for mirror, feed and origin.
 * @returns {Object} Config object.
 */
function makeEnv(overrides = {}, { mirror, feed, origin } = {}) {
  calls = [];
  const env = {
    SITE_ID,
    NORG_SITE_KEY: KEY,
    NORG_API_URL: API,
    NORG_CONTENT_BASE: CONTENT,
    EDGE_ENV: "test",
    EDGE_SCRIPT_VERSION: "0.2.0",
    EDGE_PLATFORM: "fastly",
    EDGE_PASS_CACHE: PASS,
    ...overrides,
  };
  env.EDGE_FETCH = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(CONTENT)) {
      return mirror ? mirror() : new Response("", { status: 404 });
    }
    if (String(url).includes("/bot-patterns") && feed) return feed();
    return new Response("{}", { status: 200 });
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url: String(url), init, request: typeof input === "string" ? null : input });
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
 * @param {Object} headers Extra request headers.
 * @returns {Promise<Response>} The response.
 */
const run = (path, ua, env, ip = VERIFIED_IP, headers = {}) =>
  handleRequest(
    new Request(`https://shop.example.com${path}`, { headers: { "user-agent": ua, ...headers } }),
    env,
    ip,
  );

const norgCalls = () => calls.filter((c) => c.url.startsWith(CONTENT) || c.url.startsWith(API));
const originCalls = () => calls.filter((c) => c.url.startsWith("https://shop.example.com"));

/**
 * The visit document the receptionist fetch carried, decoded.
 *
 * @returns {?Object} Decoded X-Norg-Visit, or null.
 */
function visitOn() {
  const call = calls.find((c) => c.url.startsWith(CONTENT));
  const raw = call && new Headers(call.init.headers).get("x-norg-visit");
  return raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : null;
}

const receptionistHeader = (name) => {
  const call = calls.find((c) => c.url.startsWith(CONTENT));
  return call ? new Headers(call.init.headers).get(name) : null;
};

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
});

// --- Rule 1 and rule 2: humans and search engines are never touched, and never wait

test("a real browser gets the origin, with no NORG header and no NORG call at all", async () => {
  __test_setFeed(null);
  const response = await run("/widgets/", CHROME, makeEnv());

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(response.status, 200);
  assert.deepEqual(norgCalls(), [], "a human must not pay for the feed or the mirror");
});

test("Googlebot always gets the origin, even with ?agent=true, and makes no NORG call", async () => {
  for (const path of ["/widgets/", "/widgets/?agent=true"]) {
    __test_setFeed(null);
    const response = await run(path, GOOGLEBOT, makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) }));
    assert.equal(response.headers.get("x-norg-edge"), null, path);
    assert.deepEqual(norgCalls(), [], path);
  }
});

test("a human on a NORG surface still runs the real sequence", async () => {
  for (const path of ["/ai/widgets/", "/llms.txt", "/about/index.md", "/.well-known/mcp.json"]) {
    __test_setFeed(null);
    const env = makeEnv({}, {
      mirror: () => new Response("<html>M</html>", { status: 200 }),
      origin: () => new Response("", { status: 404 }),
    });
    await run(path, CHROME, env);
    assert.ok(calls.some((c) => c.url.includes("bot-patterns")), `${path}: the feed decides entitlement here`);
  }
});

test("anything that might be an agent leaves the fast path", async () => {
  const shapes = [
    { name: "bot-shaped UA", ua: GPTBOT },
    { name: "no UA", ua: "" },
    { name: "a Web Bot Auth signature on a Chrome UA", ua: CHROME, headers: { "signature-agent": '"https://chatgpt.com"' } },
    { name: "the ?agent=true override", ua: CHROME, path: "/widgets/?agent=true" },
  ];
  for (const { name, ua, headers = {}, path = "/widgets/" } of shapes) {
    __test_setFeed(null);
    await run(path, ua, makeEnv(), VERIFIED_IP, headers);
    assert.ok(calls.some((c) => c.url.includes("bot-patterns")), `${name}: must reach the feed`);
  }
});

// --- The page is never cached at the edge ---------------------------------

test("a page passthrough carries the pass override; a static asset keeps the cache", async () => {
  __test_setFeed(FEED);
  await run("/widgets/", CHROME, makeEnv());
  assert.equal(originCalls()[0].init.cacheOverride, PASS, "a page must not be stored by Fastly");
  assert.equal(originCalls()[0].init.backend, "customer_origin");

  await run("/assets/app.css", CHROME, makeEnv());
  assert.equal(originCalls()[0].init.cacheOverride, undefined, "an asset keeps Fastly's normal caching");
  assert.equal(originCalls()[0].init.backend, "customer_origin");
});

test("the strip's origin read is never cached either", async () => {
  __test_setFeed(FEED);
  await run("/widgets/", GPTBOT, makeEnv());
  const read = originCalls()[0];
  assert.equal(read.init.cacheOverride, PASS);
  assert.equal(read.request.headers.get("x-norg-edge"), "1", "the loop guard rides on the direct read");
});

test("originFetchInit omits the override when the entry point provided none", () => {
  const request = new Request("https://shop.example.com/widgets/");
  assert.deepEqual(originFetchInit(request, {}), { backend: "customer_origin" });
});

// --- The divert path, recorded by the receptionist -------------------------

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

test("a verified agent visit is recorded by the receptionist, never by the router", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  await run("/widgets/", GPTBOT, env);

  assert.equal(calls.some((c) => c.url.includes("/api/v1/edge/events")), false, "no event call from the router");
  const visit = visitOn();
  assert.equal(visit.user_agent, GPTBOT);
  assert.equal(visit.is_ai_bot, true);
  assert.equal(visit.bot_name, "gptbot");
  assert.equal(visit.company, "openai");
  assert.equal(visit.served, "mirror");
  assert.equal(visit.served_on_miss, "stripped");
  assert.equal("ip_country" in visit, false, "Fastly publishes no viewer headers core reads; nulls are omitted");
});

test("a mirror miss strips the origin and asks the receptionist to enqueue the render", async () => {
  __test_setFeed(FEED);
  const response = await run("/widgets/", GPTBOT, makeEnv());

  assert.equal(response.headers.get("x-norg-edge"), "stripped");
  const body = await response.text();
  assert.equal(/<nav>|<script/i.test(body), false, "the strip did not run");
  assert.match(body, /word0/);
  assert.equal(receptionistHeader("x-norg-lazy-render"), "1");
  assert.equal(calls.some((c) => c.url.includes("/render-requests")), false, "the router makes no background call");
});

test("LAZY_RENDER_ENABLED=false serves the strip without asking for a render", async () => {
  __test_setFeed(FEED);
  const response = await run("/widgets/", GPTBOT, makeEnv({ LAZY_RENDER_ENABLED: "false" }));
  assert.equal(response.headers.get("x-norg-edge"), "stripped");
  assert.equal(receptionistHeader("x-norg-lazy-render"), null);
});

test("STRIP_FALLBACK_ENABLED=false is declared to the receptionist as an origin miss", async () => {
  __test_setFeed(FEED);
  const response = await run("/widgets/", GPTBOT, makeEnv({ STRIP_FALLBACK_ENABLED: "false" }));
  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(visitOn().served_on_miss, "origin");
});

test("the override and the agentic subtree carry their own visit labels", async () => {
  __test_setFeed(FEED);
  const mirror = () => new Response("<html>M</html>", { status: 200, headers: { "content-type": "text/html" } });
  await run("/widgets/?agent=true", CHROME, makeEnv({}, { mirror }));
  assert.equal(visitOn().served, "agent_param_override");
  assert.equal(visitOn().served_on_miss, "agent_param_override_miss");
  assert.equal(receptionistHeader("x-norg-lazy-render"), null, "demo traffic never enqueues a render");

  __test_setFeed(FEED);
  await run("/ai/widgets/", CHROME, makeEnv({}, { mirror }));
  assert.equal(visitOn().served, "agentic_path");
  assert.equal(visitOn().served_on_miss, "agentic_path_miss");
  assert.equal(visitOn().is_ai_bot, false, "addressed by URL, not by caller");
});

test("an origin error on the strip path is served by passthrough, never relayed", async () => {
  __test_setFeed(FEED);
  let served = 0;
  const env = makeEnv({}, {
    origin: () => {
      served += 1;
      return served === 1
        ? new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } })
        : new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  const response = await run("/widgets/", GPTBOT, env);
  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(served, 2, "the direct read is discarded and the platform's passthrough fetch answers");
});

test("a receptionist refusal stops the install diverting on the very next request", async () => {
  __test_setFeed(FEED);
  const first = await run("/widgets/", GPTBOT, makeEnv({}, { mirror: () => new Response("unauthorized", { status: 401 }) }));
  assert.equal(first.headers.get("x-norg-edge"), null, "no strip for a refused install");
  assert.equal(__test_getFeed().entitled, false);

  await run("/widgets/", GPTBOT, makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) }));
  assert.deepEqual(norgCalls(), [], "unentitled and negative-cached: no NORG call at all");
});

test("a spoofed user-agent from an unverified IP is not diverted", async () => {
  __test_setFeed(FEED);
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  const response = await run("/widgets/", GPTBOT, env, "8.8.8.8");

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(calls.some((c) => c.url.startsWith(CONTENT)), false, "no mirror lookup for an unverified source");
});

test("an unentitled install passes everything through", async () => {
  __test_setFeed({ entitled: false, patterns: [], cidrRanges: {}, skipPaths: [], fetchedAt: Date.now(), ttl: 60_000 });
  const env = makeEnv({}, { mirror: () => new Response("<html>M</html>", { status: 200 }) });
  const response = await run("/widgets/", GPTBOT, env);

  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.equal(calls.some((c) => c.url.startsWith(CONTENT)), false);
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
    assert.equal(calls.some((c) => c.url.startsWith(CONTENT)), false, `${path} hit the receptionist without entitlement`);
  }
});

// --- Background work goes to the keep-alive --------------------------------

test("a verbose human passthrough event is handed to waitUntil, never awaited", async () => {
  __test_setFeed(null);
  const held = [];
  let resolveEvent;
  const settled = new Promise((resolve) => {
    resolveEvent = resolve;
  });
  const env = makeEnv({ EDGE_EVENTS_VERBOSE: "true", EDGE_KEEPALIVE: (p) => held.push(p) });
  env.EDGE_FETCH = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    await settled;
    return new Response("{}", { status: 200 });
  };

  const response = await run("/widgets/", CHROME, env);

  assert.equal(response.status, 200, "the handler returned while the event was still in flight");
  assert.equal(held.length, 1, "the event went to the platform keep-alive");
  assert.equal(calls.filter((c) => c.url.includes("/api/v1/edge/events")).length, 1);
  resolveEvent();
  await Promise.all(held);
});

test("a stale feed is refreshed behind the response through the keep-alive", async () => {
  __test_setFeed({ ...FEED, fetchedAt: Date.now() - 10_000, ttl: 1 });
  const held = [];
  const fresh = { patterns: FEED.patterns, cidr_ranges: FEED.cidrRanges, agentic_path_prefix: "/ai", cache_ttl: 3600 };
  const env = makeEnv(
    { EDGE_KEEPALIVE: (p) => held.push(p) },
    {
      feed: () => new Response(JSON.stringify(fresh), { status: 200, headers: { "content-type": "application/json" } }),
      mirror: () => new Response("<html>M</html>", { status: 200 }),
    },
  );
  const before = __test_getFeed().fetchedAt;

  const response = await run("/widgets/", GPTBOT, env);

  assert.equal(response.headers.get("x-norg-edge"), "mirror", "the stale entry answered this request");
  assert.equal(held.length, 1, "the refresh was handed to waitUntil");
  await Promise.all(held);
  assert.ok(__test_getFeed().fetchedAt > before, "and it landed behind the response");
});

test("every NORG call goes through the backend seam, never bare fetch", async () => {
  __test_setFeed({ ...FEED, fetchedAt: Date.now() - 10_000, ttl: 1 });
  const env = makeEnv({ EDGE_EVENTS_VERBOSE: "true", EDGE_KEEPALIVE: (p) => p }, {
    mirror: () => new Response("<html>M</html>", { status: 200 }),
  });
  await run("/widgets/", GPTBOT, env);
  const bare = originCalls().filter((c) => !c.init.backend);
  assert.deepEqual(bare, [], "an unnamed backend is refused by Fastly");
  assert.ok(norgCalls().some((c) => c.url.includes("bot-patterns")), "feed via EDGE_FETCH");
  assert.ok(norgCalls().some((c) => c.url.startsWith(CONTENT)), "mirror via EDGE_FETCH");
});

// --- Floors and operator controls ------------------------------------------

test("EDGE_DISABLED is a remote off switch", async () => {
  __test_setFeed(FEED);
  const response = await run("/widgets/", GPTBOT, makeEnv({ EDGE_DISABLED: "true" }));
  assert.equal(response.headers.get("x-norg-edge"), null);
  assert.deepEqual(norgCalls(), []);
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
  assert.deepEqual(norgCalls(), []);
});

test("an authenticated health probe reports the install's state", async () => {
  __test_setFeed(FEED);
  const env = makeEnv();
  const response = await handleRequest(
    new Request("https://shop.example.com/", { headers: { "x-norg-edge-check": KEY } }),
    env,
    VERIFIED_IP,
  );
  const body = await response.json();

  assert.equal(body.site_id, SITE_ID);
  assert.equal(body.platform, "fastly");
  assert.equal(body.env, "test");
  assert.equal(body.version, "0.2.0");
});

// --- IPv6 source verification (workers/lib/cidr.mjs via core/agent.js) -------

test("an IPv6 client inside the operator's published IPv6 range gets the mirror", async () => {
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
  assert.equal(calls.some((c) => c.url.startsWith(CONTENT)), false, "no mirror lookup for an unverified source");
});
