/**
 * Edge-router worker — site-level OpenAI feed branch tests (MIRROR 10).
 *
 * Run with: node --test edge-router-worker.openai-feed.test.mjs
 *
 * The contract being protected (AC8/AC9):
 *   1. the three site-level paths are served from R2 to EVERY caller (human,
 *      search engine, AI agent) — identical bytes, no classification;
 *   2. a miss falls through to the customer origin, never a NORG error page;
 *   3. no crawler-visit events and no render-requests are emitted;
 *   4. .openai.json is exempt from canonical-Link rewriting (r2-proxy shared lib).
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  __test_isOpenAiFeedPath as isOpenAiFeedPath,
} from "./edge-router-worker.js";
import { deriveCanonicalUrl } from "./lib/alternate-format.mjs";

let moduleCounter = 0;
async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?oai=${moduleCounter}`);
  return mod.__test_handleRequest;
}

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://r2.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
};

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";
const GOOGLEBOT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

let calls;
let waitUntilTasks;
let handleRequest;

const ctx = { waitUntil: (p) => waitUntilTasks.push(p) };

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

async function drain() {
  await Promise.allSettled(waitUntilTasks);
}

function installFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init, input);
    }
    return new Response("origin body", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
}

function patternsRoute() {
  return [
    "/api/v1/edge/bot-patterns",
    async () =>
      new Response(
        JSON.stringify({
          patterns: [
            { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
          ],
          cache_ttl: 3600,
          cidr_ranges: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
}

function norgRoute(body, contentType) {
  return [
    "r2.norg.test",
    async () =>
      new Response(body, { status: 200, headers: { "content-type": contentType } }),
  ];
}

function norgMissRoute() {
  return ["r2.norg.test", async () => new Response("nope", { status: 404 })];
}

function req(path, userAgent = BROWSER) {
  return new Request(`https://customer.com${path}`, {
    headers: { "user-agent": userAgent },
  });
}

const controlCalls = () =>
  calls.filter(
    (c) =>
      c.url.includes("/edge/events") ||
      c.url.includes("/edge/render-requests") ||
      c.url.includes("/edge/heartbeat"),
  );

beforeEach(async () => {
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  handleRequest = await loadColdIsolate();
});

test("isOpenAiFeedPath matches only the three exact artifact paths", () => {
  assert.equal(isOpenAiFeedPath("/.well-known/ai-plugin.json"), true);
  assert.equal(isOpenAiFeedPath("/openapi.json"), true);
  assert.equal(isOpenAiFeedPath("/openapi.yaml"), true);
  assert.equal(isOpenAiFeedPath("/openapi.yml"), false);
  assert.equal(isOpenAiFeedPath("/products/openapi.json"), false);
  assert.equal(isOpenAiFeedPath("/.well-known/mcp.json"), false);
});

for (const [name, ua] of [
  ["human", BROWSER],
  ["search bot", GOOGLEBOT],
  ["AI agent", GPTBOT],
]) {
  test(`AC8: ai-plugin.json served from R2 to ${name}, no events`, async () => {
    installFetch([patternsRoute(), norgRoute('{"schema_version":"v1"}', "application/json")]);
    const res = await handleRequest(req("/.well-known/ai-plugin.json", ua), env, ctx);
    await drain();
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"schema_version":"v1"}');
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("X-Norg-Edge"), "openai-feed");
    assert.equal(controlCalls().length, 0);
  });
}

test("AC8: openapi.yaml carries a yaml content-type", async () => {
  installFetch([patternsRoute(), norgRoute("openapi: 3.1.0\n", "application/yaml")]);
  const res = await handleRequest(req("/openapi.yaml"), env, ctx);
  await drain();
  assert.match(res.headers.get("content-type"), /yaml/);
});

test("AC8: a miss falls through to the customer origin", async () => {
  installFetch([patternsRoute(), norgMissRoute()]);
  const res = await handleRequest(req("/openapi.json"), env, ctx);
  await drain();
  assert.equal(await res.text(), "origin body");
  assert.equal(controlCalls().length, 0);
});

test("AC9: .openai.json is exempt from canonical-Link rewriting", () => {
  const u = new URL("https://customer.com/products/widget/index.openai.json");
  assert.equal(deriveCanonicalUrl(u, u.pathname), null);
  // a normal alternate format still derives its canonical HTML URL
  const j = new URL("https://customer.com/products/widget/index.json");
  assert.notEqual(deriveCanonicalUrl(j, j.pathname), null);
});
