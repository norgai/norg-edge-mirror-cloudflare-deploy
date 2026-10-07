/**
 * Edge-router worker — record-only (capture) mode tests.
 *
 * Run with: node --test edge-router-worker.capture.test.mjs
 *
 * The contract being protected:
 *   1. the visitor always gets the origin's own response, before any NORG call
 *   2. AI agents are reported to /edge/events with served "capture" and the
 *      verified_source verdict; AI-referred people go to /edge/page-views only
 *      when NORG has citation tracking on
 *   3. a report NORG does not accept is counted and carried by the heartbeat
 *   4. mirror mode is untouched when neither switch is on
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

let moduleCounter = 0;

/** A fresh module instance per test — module state is per isolate. */
async function loadColdIsolate() {
  moduleCounter += 1;
  return import(`./edge-router-worker.js?isolate=capture-${moduleCounter}`);
}

const baseEnv = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://r2.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
};
const captureEnv = { ...baseEnv, CAPTURE_ONLY: "true" };
const HEALTH_HEADER = "x-norg-edge-check";

const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";

let calls;
let waitUntilTasks;
const ctx = { waitUntil: (p) => waitUntilTasks.push(p) };

/** Minimal Cache API stub — the colo cache layer for the feed. */
class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(req) {
    const body = this.store.get(req.url);
    return body === undefined ? undefined : { json: async () => JSON.parse(body) };
  }
  async put(req, res) {
    this.store.set(req.url, await res.text());
  }
  async delete(req) {
    return this.store.delete(req.url);
  }
}

beforeEach(() => {
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
});

async function drain() {
  // Reports can schedule further waitUntil work; settle until quiet.
  let seen = -1;
  while (seen !== waitUntilTasks.length) {
    seen = waitUntilTasks.length;
    await Promise.allSettled(waitUntilTasks);
  }
}

/** The feed body; `extra` adds capture_only / citation_tracking_enabled. */
function feedBody(extra = {}) {
  return JSON.stringify({
    patterns: [
      { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
    ],
    cache_ttl: 3600,
    cidr_ranges: {},
    ...extra,
  });
}

/**
 * Record every fetch. NORG control paths answer from `routes` (default 202);
 * anything else is the origin.
 */
function installFetch({ feed = feedBody(), events = 202, pageViews = 202, heartbeat = 202 } = {}) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init, at: calls.length });
    if (url.includes("/api/v1/edge/bot-patterns")) {
      return new Response(feed, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/v1/edge/events")) return statusOrThrow(events);
    if (url.includes("/api/v1/edge/page-views")) return statusOrThrow(pageViews);
    if (url.includes("/api/v1/edge/heartbeat")) return statusOrThrow(heartbeat);
    return new Response("origin body", { status: 200, headers: { "content-type": "text/html" } });
  };
}

function statusOrThrow(status) {
  if (status === "network") throw new TypeError("network down");
  return new Response("{}", { status });
}

function req(path = "/products/widget/", userAgent = GPTBOT, extra = {}) {
  const { cf, headers, ...init } = extra;
  const r = new Request(`https://customer.com${path}`, {
    ...init,
    headers: { "user-agent": userAgent, ...(headers || {}) },
  });
  r.cf = cf !== undefined ? cf : { verifiedBotCategory: "AI Crawler" };
  return r;
}

function posted(path) {
  return calls.filter((c) => c.url.includes(path)).map((c) => JSON.parse(c.init.body));
}

test("binding on: origin answers first, no NORG call on the request path", async () => {
  const mod = await loadColdIsolate();
  installFetch();
  // A feed that never answers: the visitor must not wait on it.
  let feedStarted = false;
  const origin = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/bot-patterns")) feedStarted = true;
    return origin(input, init);
  };
  const res = await mod.__test_handleRequest(req(), captureEnv, ctx);
  assert.equal(await res.text(), "origin body");
  assert.equal(calls[0].url, "https://customer.com/products/widget/", "origin fetched first");
  assert.equal(waitUntilTasks.length, 1, "the report runs behind the response");
  await drain();
  assert.ok(feedStarted);
  assert.ok(calls.some((c) => c.url.includes("/bot-patterns")), "feed fetched after the response");
});

test("AI agent visit is reported with served capture, status and verified_source", async () => {
  const mod = await loadColdIsolate();
  installFetch();
  await mod.__test_handleRequest(req(), captureEnv, ctx);
  await drain();
  const [event] = posted("/api/v1/edge/events");
  assert.equal(event.served, "capture");
  assert.equal(event.response_status, 200);
  assert.equal(event.verified_source, true);
  assert.equal(event.path, "/products/widget/");
});

test("unverified AI agent is still recorded, flagged verified_source false", async () => {
  const mod = await loadColdIsolate();
  installFetch();
  await mod.__test_handleRequest(req("/a/", GPTBOT, { cf: {} }), captureEnv, ctx);
  await drain();
  const [event] = posted("/api/v1/edge/events");
  assert.equal(event.verified_source, false);
});

test("static assets and plain human visits are not reported", async () => {
  const mod = await loadColdIsolate();
  installFetch();
  await mod.__test_handleRequest(req("/logo.png"), captureEnv, ctx);
  await mod.__test_handleRequest(req("/", BROWSER), captureEnv, ctx);
  await drain();
  assert.equal(posted("/api/v1/edge/events").length, 0);
  assert.equal(posted("/api/v1/edge/page-views").length, 0);
});

test("AI-referred person is sent to page-views only when citation tracking is on", async () => {
  const fromChatGpt = { headers: { referer: "https://chatgpt.com/" } };

  let mod = await loadColdIsolate();
  installFetch({ feed: feedBody({ citation_tracking_enabled: false }) });
  await mod.__test_handleRequest(req("/", BROWSER, fromChatGpt), captureEnv, ctx);
  await drain();
  assert.equal(posted("/api/v1/edge/page-views").length, 0, "tracking off: nothing sent");

  calls = [];
  globalThis.caches = { default: new FakeCache() };
  mod = await loadColdIsolate();
  installFetch({ feed: feedBody({ citation_tracking_enabled: true }) });
  await mod.__test_handleRequest(req("/", BROWSER, fromChatGpt), captureEnv, ctx);
  await drain();
  const [view] = posted("/api/v1/edge/page-views");
  assert.ok(view, "tracking on: one page view sent");
  assert.equal(view.served_surface, "customer_zone");
});

test("a rejected or failed report is counted and carried by the heartbeat", async () => {
  const mod = await loadColdIsolate();
  installFetch({ events: 429 });
  await mod.__test_handleRequest(req("/a/"), captureEnv, ctx);
  await drain();
  installFetch({ events: "network" });
  await mod.__test_recordCapture(req("/b/"), captureEnv, ctx, 200);

  installFetch();
  await mod.default.scheduled({}, captureEnv, ctx);
  await drain();
  const beats = posted("/api/v1/edge/heartbeat");
  const last = beats[beats.length - 1];
  assert.equal(last.events_dropped, 2);
  assert.equal(last.capture_mismatch, true, "binding on, feed silent: switches disagree");
  assert.equal(last.script_version, mod.EDGE_SCRIPT_VERSION);

  // Accepted beat forgets the drops it carried.
  calls = [];
  await mod.default.scheduled({}, captureEnv, ctx);
  await drain();
  assert.equal(posted("/api/v1/edge/heartbeat").pop().events_dropped, 0);
});

test("a failed heartbeat keeps the dropped count for the next one", async () => {
  const mod = await loadColdIsolate();
  installFetch({ events: 500 });
  await mod.__test_handleRequest(req("/a/"), captureEnv, ctx);
  await drain();
  installFetch({ heartbeat: 503 });
  await mod.default.scheduled({}, captureEnv, ctx);
  installFetch();
  calls = [];
  await mod.default.scheduled({}, captureEnv, ctx);
  assert.equal(posted("/api/v1/edge/heartbeat").pop().events_dropped, 1);
});

test("feed capture_only switches a site with no binding into record-only", async () => {
  const mod = await loadColdIsolate();
  installFetch({ feed: feedBody({ capture_only: true }) });
  const res = await mod.__test_handleRequest(req(), baseEnv, ctx);
  assert.equal(await res.text(), "origin body");
  assert.ok(!calls.some((c) => c.url.includes("r2.norg.test")), "no mirror content fetched");
  await drain();
  const [event] = posted("/api/v1/edge/events");
  assert.equal(event.served, "capture");
  assert.deepEqual(mod.__test_captureState(baseEnv), { active: true, mismatch: true });
});

test("both switches on: active, no mismatch; health reports capture_only", async () => {
  const mod = await loadColdIsolate();
  installFetch({ feed: feedBody({ capture_only: true }) });
  await mod.__test_handleRequest(req(), captureEnv, ctx);
  await drain();
  assert.deepEqual(mod.__test_captureState(captureEnv), { active: true, mismatch: false });
  const probe = req("/", BROWSER, { headers: { [HEALTH_HEADER]: captureEnv.NORG_SITE_KEY } });
  const health = await (await mod.__test_handleRequest(probe, captureEnv, ctx)).json();
  assert.equal(health.capture_only, true);
});

test("neither switch on: mirror path unchanged, no capture fields in heartbeat", async () => {
  const mod = await loadColdIsolate();
  installFetch();
  await mod.__test_handleRequest(req("/products/widget/"), baseEnv, ctx);
  await drain();
  assert.ok(calls.some((c) => c.url.includes("r2.norg.test")), "mirror content looked up");
  assert.ok(!posted("/api/v1/edge/events").some((e) => e.served === "capture"));
  calls = [];
  await mod.default.scheduled({}, baseEnv, ctx);
  await drain();
  const beat = posted("/api/v1/edge/heartbeat").pop();
  assert.equal("events_dropped" in beat, false);
  assert.equal("capture_mismatch" in beat, false);
  assert.deepEqual(mod.__test_captureState(baseEnv), { active: false, mismatch: false });
});

test("origin failure in capture mode still ends at the origin, never a NORG error", async () => {
  const mod = await loadColdIsolate();
  installFetch();
  const res = await mod.default.fetch(req("/x/"), captureEnv, ctx);
  assert.equal(res.status, 200);
});
