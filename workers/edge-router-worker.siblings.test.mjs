/**
 * Edge-router worker — per-page sibling serving (MIRROR 03).
 *
 * Integration-level coverage that the worker, when serving a NORG-mirrored
 * sibling to a diverted agent, applies the ALTERNATE_FORMAT canonical Link +
 * X-Robots-Tag: noindex treatment (AC3) and exempts /mcp.json (AC3), and that
 * /.well-known/mcp.json is served from NORG to an unclassified caller instead
 * of falling through to origin (AC5). Drives __test_handleRequest with a
 * stubbed fetch (NORG bot-patterns + R2 content), mirroring the harness in
 * edge-router-worker.pipeline.test.mjs.
 *
 * Run with: node --test edge-router-worker.siblings.test.mjs
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

let moduleCounter = 0;
let handleRequest;

async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?sib=${moduleCounter}`);
  return mod.__test_handleRequest;
}

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://r2.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
  STRIP_FALLBACK_ENABLED: "true",
};

const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";
const VERIFIED_CF = { verifiedBotCategory: "AI Crawler" };

let calls;
let waitUntilTasks;

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

class FakeHTMLRewriter {
  on() {
    return this;
  }
  transform(response) {
    return response;
  }
}

async function drain() {
  await Promise.allSettled(waitUntilTasks);
}

function installFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init);
    }
    return new Response("origin body", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
}

/** NORG bot-patterns feed: gptbot -> divert (so a GPTBot hit is mirrored). */
function patternsRoute() {
  return [
    "/api/v1/edge/bot-patterns",
    async () =>
      new Response(
        JSON.stringify({
          patterns: [
            {
              pattern: "gptbot",
              company: "openai",
              purpose: "training",
              serving_policy: "divert",
            },
          ],
          cache_ttl: 3600,
          cidr_ranges: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
}

/** R2 content: answers any mirror key; content-type keyed off the extension. */
function contentRoute() {
  return [
    "r2.norg.test",
    async (url) => {
      const ct = url.endsWith(".md")
        ? "text/markdown; charset=utf-8"
        : url.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/html; charset=utf-8";
      return new Response("body", { status: 200, headers: { "content-type": ct } });
    },
  ];
}

function req(path, userAgent = GPTBOT) {
  const r = new Request(`https://customer.com${path}`, {
    headers: { "user-agent": userAgent },
  });
  r.cf = VERIFIED_CF;
  return r;
}

beforeEach(async () => {
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  globalThis.HTMLRewriter = FakeHTMLRewriter;
  handleRequest = await loadColdIsolate();
  installFetch([patternsRoute(), contentRoute()]);
});

// AC3: "/page.md ... served ... with Link rel=canonical to the clean page URL
// and X-Robots-Tag: noindex."
test("AC3: a served .md sibling carries canonical Link + noindex", async () => {
  const response = await handleRequest(req("/about/index.md"), env, ctx);
  await drain();
  // Served from the NORG mirror, not the origin.
  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
  // Canonical points at the clean customer page URL (index.{ext} -> directory).
  assert.equal(
    response.headers.get("Link"),
    '<https://customer.com/about/>; rel="canonical"',
  );
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
});

// AC3: "/page.json" behaves like /page.md.
test("AC3: a served .json sibling carries canonical Link + noindex", async () => {
  const response = await handleRequest(req("/about/index.json"), env, ctx);
  await drain();
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
  assert.equal(
    response.headers.get("Link"),
    '<https://customer.com/about/>; rel="canonical"',
  );
});

// AC3: "/mcp.json ... exempt from that header treatment (tests mirror the
// r2-proxy exclusions)."
test("AC3: a served per-page mcp.json is EXEMPT from canonical/noindex", async () => {
  const response = await handleRequest(req("/about/mcp.json"), env, ctx);
  await drain();
  assert.equal(response.headers.get("X-Norg-Edge"), "mirror"); // still served
  assert.equal(response.headers.get("X-Robots-Tag"), null);
  assert.equal(response.headers.get("Link"), null);
});

// AC5: "/.well-known/mcp.json is served to an unclassified caller with the
// site-level manifest instead of falling through to origin."
test("AC5: /.well-known/mcp.json is served from NORG to an unclassified caller", async () => {
  const response = await handleRequest(
    req("/.well-known/mcp.json", BROWSER),
    env,
    ctx,
  );
  await drain();
  // Served by the MCP branch (handleMcp) from NORG, not the origin passthrough.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Norg-Edge"), "mcp");
  // It reached the NORG content stem for the well-known key, not the origin.
  const norgHit = calls.find((c) => c.url.includes("/.well-known/mcp.json"));
  assert.ok(
    norgHit && norgHit.url.startsWith("https://r2.norg.test/site-123/"),
    "well-known manifest fetched from the NORG content stem",
  );
  // AC5 exemption parity: the manifest itself carries no noindex.
  assert.equal(response.headers.get("X-Robots-Tag"), null);
});

// ---------------------------------------------------------------------------
// Sibling artifacts are advertised in mcp.json by absolute URL, so an MCP
// client fetching one is an ordinary unclassified caller — not a UA-and-IP
// verified bot. Before this branch existed webmcp.js and index.pdf were
// answered by the static-asset floor and the rest never left the agent path,
// so every advertised alternate 404'd at the customer's origin.
// ---------------------------------------------------------------------------
test("webmcp.js is served from NORG to an unclassified caller", async () => {
  const response = await handleRequest(req("/about/webmcp.js", BROWSER), env, ctx);
  await drain();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
  assert.ok(
    calls.some((c) => c.url === "https://r2.norg.test/site-123/about/webmcp.js"),
    "webmcp.js must be read from the NORG content stem",
  );
});

test("index.pdf clears the static-asset floor and is served from NORG", async () => {
  const response = await handleRequest(req("/about/index.pdf", BROWSER), env, ctx);
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
});

test("the customer's own file at a sibling path wins over the NORG copy", async () => {
  installFetch([
    patternsRoute(),
    contentRoute(),
    [
      "customer.com/about/index.json",
      async () =>
        new Response("customer body", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
  ]);

  const response = await handleRequest(req("/about/index.json", BROWSER), env, ctx);
  await drain();

  assert.equal(await response.text(), "customer body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
});

test("an unpublished sibling falls through to the customer's origin", async () => {
  installFetch([
    patternsRoute(),
    ["r2.norg.test", async () => new Response("nope", { status: 404 })],
  ]);

  const response = await handleRequest(req("/about/webmcp.js", BROWSER), env, ctx);
  await drain();

  assert.equal(await response.text(), "origin body");
  assert.equal(response.headers.get("X-Norg-Edge"), null);
});
