/**
 * Edge-router worker — discovery-artifact branch tests (llms.txt / llms-full.txt
 * / tree.json).
 *
 * Run with: node --test edge-router-worker.discovery.test.mjs
 *
 * The contract being protected:
 *   1. the customer's own file always wins (origin-first probe)
 *   2. every caller gets identical bytes — no classification on this path
 *   3. an HTML 200 is a SPA soft-404, not a real artifact
 *   4. any miss ends at the origin response, never a NORG error page
 *   5. no crawler-visit events and no render-requests are emitted
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  __test_isDiscoveryPath as isDiscoveryPath,
} from "./edge-router-worker.js";

let moduleCounter = 0;
let handleRequest;

async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?disc=${moduleCounter}`);
  return mod.__test_handleRequest;
}

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://r2.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
};

const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

let calls;
let waitUntilTasks;

const ctx = {
  waitUntil: (p) => {
    waitUntilTasks.push(p);
  },
};

/** Minimal Cache API stub — the colo cache layer for bot patterns. */
class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(req) {
    const body = this.store.get(req.url);
    if (body === undefined) return undefined;
    return { json: async () => JSON.parse(body) };
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

/** Records every fetch and answers from a url->handler routing table. */
function installFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers =
      typeof input === "string" ? init.headers : input.headers;
    calls.push({ url, headers, init, input });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init, input);
    }
    // Default origin: an HTML 200 (a SPA soft-404 for a missing artifact).
    return new Response("origin body", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
}

/** Bot patterns come from NORG; a 200 here is also the entitlement signal. */
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

/** The receptionist serving the NORG copy for the requested key. */
function norgRoute(body, contentType = "text/plain") {
  return [
    "r2.norg.test",
    async () =>
      new Response(body, { status: 200, headers: { "content-type": contentType } }),
  ];
}

/** The receptionist missing the NORG copy (definite 404). */
function norgMissRoute() {
  return ["r2.norg.test", async () => new Response("nope", { status: 404 })];
}

/** An origin answering /llms.txt (etc.) with a fixed response. */
function originRoute(status, body, contentType) {
  return [
    "customer.com",
    async () =>
      new Response(body, {
        status,
        headers: contentType ? { "content-type": contentType } : {},
      }),
  ];
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

test("isDiscoveryPath matches only the exact artifact paths", () => {
  assert.equal(isDiscoveryPath("/llms.txt"), true);
  assert.equal(isDiscoveryPath("/llms-full.txt"), true);
  assert.equal(isDiscoveryPath("/tree.json"), true);
  // agents.md is the capability contract NORG publishes beside the others;
  // before 0.11.5 it fell through to the origin and 404'd on most sites.
  assert.equal(isDiscoveryPath("/agents.md"), true);
  // Exact-match only: a customer page merely ending in the name is NOT ours.
  assert.equal(isDiscoveryPath("/blog/agents.md"), false);
  assert.equal(isDiscoveryPath("/agents.md/"), false);
  assert.equal(isDiscoveryPath("/llms.txt/"), false);
  assert.equal(isDiscoveryPath("/products/llms.txt"), false);
  assert.equal(isDiscoveryPath("/about/"), false);
});

test("AC2: origin's own llms.txt (200 text/plain) passes through, NORG not consulted", async () => {
  installFetch([
    patternsRoute(),
    originRoute(200, "# customer's own\n", "text/plain"),
    norgRoute("# NORG copy\n"),
  ]);
  const res = await handleRequest(req("/llms.txt"), env, ctx);
  await drain();
  assert.equal(await res.text(), "# customer's own\n");
  assert.equal(calls.filter((c) => c.url.includes("r2.norg.test")).length, 0);
});

test("AC3: origin 404 -> NORG copy, identical bytes for browser, GPTBot, googlebot", async () => {
  const bodies = [];
  for (const ua of [BROWSER, GPTBOT, GOOGLEBOT]) {
    calls = [];
    waitUntilTasks = [];
    globalThis.caches = { default: new FakeCache() };
    handleRequest = await loadColdIsolate();
    installFetch([
      patternsRoute(),
      originRoute(404, "not found", "text/plain"),
      norgRoute("# NORG copy\n- [Home](https://customer.com/)\n"),
    ]);
    const res = await handleRequest(req("/llms.txt", ua), env, ctx);
    await drain();
    assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
    bodies.push(await res.text());
  }
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[1], bodies[2]);
});

test("AC4: origin 200 text/html is a soft-404 -> NORG copy served", async () => {
  installFetch([
    patternsRoute(),
    originRoute(200, "<html>SPA shell</html>", "text/html"),
    norgRoute("# NORG copy\n"),
  ]);
  const res = await handleRequest(req("/llms.txt"), env, ctx);
  await drain();
  assert.equal(await res.text(), "# NORG copy\n");
  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
});

test("AC5: origin 404 AND receptionist miss -> origin 404 returned verbatim", async () => {
  installFetch([
    patternsRoute(),
    originRoute(404, "origin not found", "text/plain"),
    norgMissRoute(),
  ]);
  const res = await handleRequest(req("/llms.txt"), env, ctx);
  await drain();
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "origin not found");
  assert.equal(res.headers.get("X-Norg-Edge"), null);
});

test("AC6: discovery paths emit no crawler-visit events and no render-requests", async () => {
  for (const path of ["/llms.txt", "/llms-full.txt", "/tree.json"]) {
    calls = [];
    waitUntilTasks = [];
    globalThis.caches = { default: new FakeCache() };
    handleRequest = await loadColdIsolate();
    installFetch([
      patternsRoute(),
      originRoute(404, "nf", "text/plain"),
      norgRoute("copy"),
    ]);
    await handleRequest(req(path, GPTBOT), env, ctx);
    await drain();
    assert.equal(controlCalls().length, 0, `${path} triggered a control-plane call`);
  }
});

test("AC7: /llms-full.txt and /tree.json follow the same origin-first rules", async () => {
  // origin wins for a real file
  installFetch([
    patternsRoute(),
    originRoute(200, "{\"own\":true}", "application/json"),
    norgRoute("{\"norg\":true}", "application/json"),
  ]);
  let res = await handleRequest(req("/tree.json"), env, ctx);
  await drain();
  assert.equal(await res.text(), "{\"own\":true}");
  assert.equal(calls.filter((c) => c.url.includes("r2.norg.test")).length, 0);

  // soft-404 html -> NORG copy for llms-full.txt
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  handleRequest = await loadColdIsolate();
  installFetch([
    patternsRoute(),
    originRoute(200, "<html>shell</html>", "text/html"),
    norgRoute("# full\n"),
  ]);
  res = await handleRequest(req("/llms-full.txt"), env, ctx);
  await drain();
  assert.equal(await res.text(), "# full\n");
});

test("MIRROR 08: /graph.jsonld joins the exact discovery set", () => {
  assert.equal(isDiscoveryPath("/graph.jsonld"), true);
  assert.equal(isDiscoveryPath("/graph.jsonld/"), false);
  assert.equal(isDiscoveryPath("/products/graph.jsonld"), false);
});

test("MIRROR 08: /graph.jsonld origin 404 -> NORG mirror copy served", async () => {
  installFetch([
    patternsRoute(),
    originRoute(404, "not found", "text/plain"),
    norgRoute('{"@context":"https://schema.org","@graph":[]}', "application/ld+json"),
  ]);
  const res = await handleRequest(req("/graph.jsonld"), env, ctx);
  await drain();
  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(await res.text(), '{"@context":"https://schema.org","@graph":[]}');
});

test("MIRROR 08: origin's own /graph.jsonld (200 ld+json) passes through, NORG not consulted", async () => {
  installFetch([
    patternsRoute(),
    originRoute(200, '{"own":true}', "application/ld+json"),
    norgRoute('{"norg":true}', "application/ld+json"),
  ]);
  const res = await handleRequest(req("/graph.jsonld"), env, ctx);
  await drain();
  assert.equal(await res.text(), '{"own":true}');
  assert.equal(calls.filter((c) => c.url.includes("r2.norg.test")).length, 0);
});

test("MIRROR 08: /graph.jsonld origin 200 text/html is a soft-404 -> NORG copy", async () => {
  installFetch([
    patternsRoute(),
    originRoute(200, "<html>SPA shell</html>", "text/html"),
    norgRoute('{"@graph":[]}', "application/ld+json"),
  ]);
  const res = await handleRequest(req("/graph.jsonld"), env, ctx);
  await drain();
  assert.equal(await res.text(), '{"@graph":[]}');
  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
});

test("MIRROR 08: /graph.jsonld emits no crawler-visit events and no render-requests", async () => {
  installFetch([
    patternsRoute(),
    originRoute(404, "nf", "text/plain"),
    norgRoute('{"@graph":[]}', "application/ld+json"),
  ]);
  await handleRequest(req("/graph.jsonld", GPTBOT), env, ctx);
  await drain();
  assert.equal(controlCalls().length, 0);
});

test("the origin probe carries the loop-guard header so it is not reprocessed", async () => {
  installFetch([
    patternsRoute(),
    originRoute(404, "nf", "text/plain"),
    norgMissRoute(),
  ]);
  await handleRequest(req("/llms.txt"), env, ctx);
  await drain();
  const probe = calls.find(
    (c) => c.url === "https://customer.com/llms.txt",
  );
  assert.ok(probe, "expected an origin probe to customer.com/llms.txt");
  assert.equal(probe.input.headers.get("x-norg-edge"), "1");
});

// A discovery file is NOT a format variant of a page. deriveCanonicalUrl reads
// any .json/.jsonld it is handed as one, so serving these through the shared
// origin-first helper with the alternate-format treatment enabled would stamp
// /tree.json with a rel=canonical to /tree/ — a URL that does not exist.
test("a served discovery artifact carries no canonical Link or noindex", async () => {
  for (const path of ["/tree.json", "/graph.jsonld", "/llms.txt"]) {
    installFetch([
      patternsRoute(),
      ["customer.com", async () => new Response("nope", { status: 404 })],
      [
        "r2.norg.test",
        async () =>
          new Response("norg copy", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ],
    ]);

    const response = await handleRequest(req(path, BROWSER), env, ctx);
    await drain();

    assert.equal(response.headers.get("X-Norg-Edge"), "mirror", `${path} served`);
    assert.equal(response.headers.get("Link"), null, `${path} must have no Link`);
    assert.equal(
      response.headers.get("X-Robots-Tag"),
      null,
      `${path} must have no X-Robots-Tag`,
    );
  }
});
