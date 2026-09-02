/**
 * Edge-router worker — reserved-path ORDERING tests (story [MIRROR 02], AC7).
 *
 * Run with: node --test edge-router-worker.reserved-theme-ordering.test.mjs
 *
 * AC7: the /.norg/ branch is reached AFTER the loop-guard/passthrough and the
 * entitlement gate, and BEFORE the traditional-search-bot floor + classification.
 * The reserved-theme.test.mjs suite proves the "before the search-bot floor"
 * half (googlebot still gets the CSS). This file proves the "after" half:
 *   1. an unentitled install NEVER serves /.norg/* — it passes straight to
 *      origin and makes no receptionist (NORG) fetch (entitlement precedes it).
 *   2. a loop-guard subrequest (x-norg-edge header) to /.norg/* passes through
 *      untouched (passthrough precedes it) — no infinite recursion.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

let moduleCounter = 0;
let handleRequest;

async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?ord=${moduleCounter}`);
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
    calls.push({ url, init, input });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init, input);
    }
    return new Response("origin page", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
}

/** The feed endpoint REFUSING this install (bad key 401 / paused site 403). */
function refusedPatternsRoute(status = 403) {
  return ["/api/v1/edge/bot-patterns", async () => new Response("no", { status })];
}

/** The receptionist WOULD serve CSS — present to prove it is never consulted. */
function norgCssRoute() {
  return [
    "r2.norg.test",
    async () =>
      new Response(":root{--x:1}", {
        status: 200,
        headers: { "content-type": "text/css; charset=utf-8" },
      }),
  ];
}

const norgCalls = () => calls.filter((c) => c.url.includes("r2.norg.test"));

beforeEach(async () => {
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  handleRequest = await loadColdIsolate();
});

test("AC7: an UNENTITLED install passes /.norg/theme.css to origin and never fetches NORG", async () => {
  installFetch([refusedPatternsRoute(403), norgCssRoute()]);
  const res = await handleRequest(
    new Request("https://customer.com/.norg/theme.css", {
      headers: { "user-agent": BROWSER },
    }),
    env,
    ctx,
  );
  await drain();
  // Entitlement gate runs BEFORE the reserved branch: origin page, not CSS.
  assert.equal(await res.text(), "origin page");
  assert.equal(res.headers.get("x-norg-edge"), null);
  assert.equal(norgCalls().length, 0, "unentitled must make no receptionist fetch");
});

test("AC7: a loop-guard subrequest to /.norg/theme.css passes through (passthrough precedes the branch)", async () => {
  installFetch([refusedPatternsRoute(403), norgCssRoute()]);
  const res = await handleRequest(
    new Request("https://customer.com/.norg/theme.css", {
      headers: { "user-agent": BROWSER, "x-norg-edge": "1" },
    }),
    env,
    ctx,
  );
  await drain();
  // isPassthrough short-circuits before entitlement AND before the reserved
  // branch — the request is served by origin with no NORG involvement.
  assert.equal(await res.text(), "origin page");
  assert.equal(norgCalls().length, 0, "loop-guard request must not fetch NORG");
});
