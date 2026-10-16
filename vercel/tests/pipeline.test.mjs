/**
 * The Vercel request pipeline, end to end through createNorgEdge.
 *
 * @description Proves the middleware makes the Cloudflare worker's decisions.
 *
 * The first test matters most: a real browser must come back with nothing
 * from this package (undefined = "continue to the site") and must cause no
 * NORG call at all.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { __test_setFeed } from "../../core/feed.js";
import { createNorgEdge } from "../src/index.js";
import { __test_resetHeartbeat } from "../src/lib/heartbeat.js";
import {
  API_URL,
  CHROME_UA,
  CONTENT_BASE,
  GOOGLEBOT_UA,
  GPTBOT_UA,
  OPTIONS,
  SITE_ID,
  SITE_KEY,
  UNVERIFIED_IP,
  html,
  json,
  norgCalls,
  stubNetwork,
  vercelRequest,
  visitOn,
  waitUntilContext,
} from "./helpers.mjs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
  __test_resetHeartbeat();
});

const mirrorHit = () => html("<html><body>mirror</body></html>");

/**
 * Run the handler once on a cold instance.
 *
 * @param {Object} requestOptions Options for vercelRequest.
 * @param {Object} network Options for stubNetwork.
 * @param {Object} [options] Factory options.
 * @returns {Promise<{result: ?Response, calls: Array, context: Object}>} Outcome.
 */
async function run(requestOptions = {}, network = {}, options = OPTIONS) {
  const { calls } = stubNetwork(network);
  const context = waitUntilContext();
  const result = await createNorgEdge(options)(vercelRequest(requestOptions), context);
  await Promise.all(context.pending);
  return { result, calls, context };
}

test("a real browser is untouched and causes no NORG call", async () => {
  const { result, calls } = await run({ userAgent: CHROME_UA });
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("a search engine is untouched, even with ?agent=true", async () => {
  for (const path of ["/widgets/", "/widgets/?agent=true"]) {
    const { result, calls } = await run({ userAgent: GOOGLEBOT_UA, path });
    assert.equal(result, undefined, path);
    assert.equal(norgCalls(calls).filter((c) => c.url.startsWith(CONTENT_BASE)).length, 0);
  }
});

test("a verified agent gets the render, uncacheable, at its own URL", async () => {
  const { result, calls } = await run({}, { mirror: mirrorHit });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
  assert.match(result.headers.get("cache-control"), /no-store/);
  assert.equal(await result.text(), "<html><body>mirror</body></html>");
  const mirrorCall = calls.find((c) => c.url.startsWith(CONTENT_BASE));
  assert.equal(mirrorCall.url, `${CONTENT_BASE}/${SITE_ID}/widgets/index.html`);
  const headers = new Headers(mirrorCall.init.headers);
  assert.equal(headers.get("x-norg-site-key"), SITE_KEY);
  assert.equal(headers.get("x-norg-lazy-render"), "1");
});

test("the visit header carries Vercel's geo under the shared field names", async () => {
  const { calls } = await run({}, { mirror: mirrorHit });
  const visit = visitOn(calls);
  assert.equal(visit.bot_name !== undefined, true);
  assert.equal(visit.served, "mirror");
  assert.equal(visit.served_on_miss, "stripped");
  assert.equal(visit.ip_country, "AU");
  assert.equal(visit.ip_city, "São Paulo");
});

test("a verified agent on an unrendered page gets the stripped page", async () => {
  const { result, calls } = await run();
  assert.equal(result.headers.get("x-norg-edge"), "stripped");
  assert.doesNotMatch(await result.text(), /<script|<nav/);
  const originCall = calls.find((c) => c.url === "https://shop.example.com/widgets/");
  assert.equal(new Headers(originCall.init.headers).get("x-norg-edge"), "1");
});

test("a thin page is not stripped: the site answers", async () => {
  const { result } = await run({}, { origin: () => html("<html><body>tiny</body></html>") });
  assert.equal(result, undefined);
});

test("an agent UA from an unverified IP is untouched", async () => {
  const { result, calls } = await run({ ip: UNVERIFIED_IP }, { mirror: mirrorHit });
  assert.equal(result, undefined);
  assert.equal(calls.filter((c) => c.url.startsWith(CONTENT_BASE)).length, 0);
});

test("off Vercel, a client-supplied x-real-ip is never trusted", async () => {
  const options = { ...OPTIONS, trustVercelHeaders: false };
  const { result } = await run({}, { mirror: mirrorHit }, options);
  assert.equal(result, undefined);
});

test("getClientIp lets a self-hosted app supply the address", async () => {
  const options = { ...OPTIONS, trustVercelHeaders: false, getClientIp: () => "20.171.9.9" };
  const { result } = await run({ ip: UNVERIFIED_IP }, { mirror: mirrorHit }, options);
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
});

test("without credentials the package is inert", async () => {
  const { siteKey, ...noKey } = OPTIONS;
  const { result, calls } = await run({}, { mirror: mirrorHit }, noKey);
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("a refused install changes nothing", async () => {
  const refused = () => new Response("", { status: 401 });
  const { result } = await run({}, { feed: refused, mirror: mirrorHit });
  assert.equal(result, undefined);
});

test("NORG unreachable: the site answers", async () => {
  const down = () => {
    throw new TypeError("fetch failed");
  };
  const { result } = await run({}, { feed: down, mirror: down });
  assert.equal(result, undefined);
});

test("a throw anywhere in the pipeline still answers with the site", async () => {
  const options = {
    ...OPTIONS,
    getClientIp: () => {
      throw new Error("boom");
    },
  };
  const { result } = await run({}, { mirror: mirrorHit }, options);
  assert.equal(result, undefined);
});

test("the kill switch and the loop guard pass everything through", async () => {
  const off = await run({}, { mirror: mirrorHit }, { ...OPTIONS, disabled: true });
  assert.equal(off.result, undefined);
  const looped = await run({ headers: { "x-norg-edge": "1" } }, { mirror: mirrorHit });
  assert.equal(looped.result, undefined);
});

test("a skipped path is untouched", async () => {
  const { result } = await run({ path: "/checkout" }, { mirror: mirrorHit });
  assert.equal(result, undefined);
});

test("the agentic subtree is served by URL, to a person too", async () => {
  const { result, calls } = await run({ path: "/ai/widgets/", userAgent: CHROME_UA }, { mirror: mirrorHit });
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
  assert.ok(calls.some((c) => c.url === `${CONTENT_BASE}/${SITE_ID}/widgets/index.html`));
});

test("llms.txt: the site's own file wins, otherwise NORG's", async () => {
  const own = () => new Response("own", { status: 200, headers: { "content-type": "text/plain" } });
  const mine = await run({ path: "/llms.txt", userAgent: CHROME_UA }, { origin: own, mirror: mirrorHit });
  assert.equal(mine.result, undefined);
  const none = () => new Response("", { status: 404 });
  const norg = await run({ path: "/llms.txt", userAgent: CHROME_UA }, { origin: none, mirror: mirrorHit });
  assert.equal(norg.result.headers.get("x-norg-edge"), "mirror");
});

test("MCP POST is forwarded with only the JSON-RPC headers", async () => {
  const control = (url, init) => {
    assert.equal(url, `${API_URL}/public-mcp/`);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("x-norg-edge-page"), "/mcp");
    return json({ jsonrpc: "2.0", id: 1, result: {} });
  };
  const { result } = await run(
    { path: "/mcp", method: "POST", userAgent: CHROME_UA, headers: { cookie: "s=1", "content-type": "application/json" }, body: "{}" },
    { control },
  );
  assert.equal(result.status, 200);
});

test("MCP POST that NORG cannot serve falls back to the site", async () => {
  const control = () => new Response("", { status: 502 });
  const { result } = await run(
    { path: "/mcp", method: "POST", userAgent: CHROME_UA, body: "{}" },
    { control },
  );
  assert.equal(result, undefined);
});

test("the health probe reports platform, version and entitlement", async () => {
  const { result, calls } = await run({ userAgent: CHROME_UA, headers: { "x-norg-edge-check": SITE_KEY } });
  const body = await result.json();
  assert.equal(body.platform, "vercel");
  assert.equal(body.site_id, SITE_ID);
  assert.equal(body.entitled, true);
  assert.match(result.headers.get("cache-control"), /no-store/);
  const beat = calls.find((c) => c.url === `${API_URL}/api/v1/edge/heartbeat`);
  assert.equal(JSON.parse(beat.init.body).trigger, "probe");
});

test("a wrong probe key is treated as an ordinary visit", async () => {
  const { result } = await run({ userAgent: CHROME_UA, headers: { "x-norg-edge-check": "nope" } });
  assert.equal(result, undefined);
});

test("serving an agent sends one traffic heartbeat per interval, via waitUntil", async () => {
  const first = await run({}, { mirror: mirrorHit });
  const beat = first.calls.find((c) => c.url.endsWith("/api/v1/edge/heartbeat"));
  const body = JSON.parse(beat.init.body);
  assert.deepEqual(
    { trigger: body.trigger, platform: body.platform, colo: body.colo, env: body.env },
    { trigger: "traffic", platform: "vercel", colo: "syd1", env: "test" },
  );
  assert.ok(first.context.pending.length >= 1);
  const second = await run({}, { mirror: mirrorHit });
  assert.equal(second.calls.filter((c) => c.url.endsWith("/heartbeat")).length, 0);
});

test("static assets never reach NORG", async () => {
  const { result, calls } = await run({ path: "/_next/static/chunks/app.js" }, { mirror: mirrorHit });
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("the probe key is compared in constant time and a wrong length is rejected", async () => {
  const { __test_constantTimeEqual: eq } = await import("../src/router.js");
  assert.equal(eq("nek_live_abc", "nek_live_abc"), true);
  assert.equal(eq("nek_live_abc", "nek_live_abd"), false);
  assert.equal(eq("nek_live_abc", "nek_live_ab"), false);
  assert.equal(eq("", ""), true);
});

test("an oversized MCP POST is never buffered: the site answers", async () => {
  const { __test_MCP_MAX_BODY_BYTES: cap } = await import("../src/router.js");
  const { result, calls } = await run(
    {
      path: "/mcp",
      method: "POST",
      userAgent: CHROME_UA,
      headers: { "content-length": String(cap + 1), "content-type": "application/json" },
      body: "{}",
    },
    { control: () => json({ jsonrpc: "2.0", id: 1, result: {} }) },
  );
  assert.equal(result, undefined);
  assert.equal(calls.filter((c) => c.url.includes("/public-mcp")).length, 0);
});
