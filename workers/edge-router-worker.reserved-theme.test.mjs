/**
 * Edge-router worker — reserved NORG asset branch tests (/.norg/theme.css).
 *
 * Run with: node --test edge-router-worker.reserved-theme.test.mjs
 *
 * The contract being protected (story [MIRROR 02]):
 *   1. /.norg/* is served to every caller from NORG BEFORE classification and
 *      the search-bot floor — a browser UA is NOT classified, googlebot gets
 *      the same bytes (no cloaking surface).
 *   2. a hit is re-served with PUBLIC cache headers + text/css (not the private
 *      no-store contract used for tenant renders), and origin is not consulted.
 *   3. a miss falls through to the customer origin — never a synthesised error.
 *   4. no crawler-visit events and no render-requests are emitted (asset fetch).
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  __test_isReservedNorgPath as isReservedNorgPath,
} from "./edge-router-worker.js";

let moduleCounter = 0;
let handleRequest;

async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?theme=${moduleCounter}`);
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
const GOOGLEBOT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const CSS = "/* === Per-Directory Master CSS === */\n:root{--x:1}\n";

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
    // Default origin: an ordinary customer page.
    return new Response("origin page", {
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

/** The receptionist serving the theme.css for the requested key. */
function norgCssRoute() {
  return [
    "r2.norg.test",
    async () =>
      new Response(CSS, {
        status: 200,
        headers: { "content-type": "text/css; charset=utf-8" },
      }),
  ];
}

/** The receptionist missing the theme.css (definite 404). */
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

const originCalls = () => calls.filter((c) => c.url.includes("customer.com"));

beforeEach(async () => {
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  handleRequest = await loadColdIsolate();
});

test("isReservedNorgPath matches the whole /.norg/ prefix, not siblings", () => {
  assert.equal(isReservedNorgPath("/.norg/theme.css"), true);
  assert.equal(isReservedNorgPath("/.norg/anything.css"), true);
  assert.equal(isReservedNorgPath("/.norganic/x"), false);
  assert.equal(isReservedNorgPath("/products/.norg/theme.css"), false);
  assert.equal(isReservedNorgPath("/about/"), false);
});

test("AC2: browser UA served theme.css from NORG (not origin, not classified), text/css + public cache", async () => {
  installFetch([patternsRoute(), norgCssRoute()]);
  const res = await handleRequest(req("/.norg/theme.css"), env, ctx);
  await drain();
  assert.equal(res.status, 200);
  assert.equal(await res.text(), CSS);
  assert.match(res.headers.get("content-type"), /text\/css/);
  assert.match(res.headers.get("cache-control"), /public/);
  assert.equal(res.headers.get("x-norg-edge"), "reserved-asset");
  // origin was never consulted for the asset (NORG-first, hit).
  assert.equal(originCalls().length, 0);
});

test("AC5-miss: receptionist miss falls through to origin, no synthesised error", async () => {
  installFetch([patternsRoute(), norgMissRoute()]);
  const res = await handleRequest(req("/.norg/theme.css"), env, ctx);
  await drain();
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "origin page");
  assert.equal(res.headers.get("x-norg-edge"), null);
});

test("AC3: /.norg/ requests emit no crawler-visit events and no render-requests (hit or miss)", async () => {
  for (const routes of [[patternsRoute(), norgCssRoute()], [patternsRoute(), norgMissRoute()]]) {
    calls = [];
    waitUntilTasks = [];
    globalThis.caches = { default: new FakeCache() };
    handleRequest = await loadColdIsolate();
    installFetch(routes);
    await handleRequest(req("/.norg/theme.css", GOOGLEBOT), env, ctx);
    await drain();
    assert.equal(controlCalls().length, 0);
  }
});

test("AC5-floor: googlebot gets the CSS (same bytes) but a normal page still goes to origin", async () => {
  installFetch([patternsRoute(), norgCssRoute()]);
  const res = await handleRequest(req("/.norg/theme.css", GOOGLEBOT), env, ctx);
  await drain();
  assert.equal(await res.text(), CSS, "googlebot must get identical CSS bytes");

  // A normal page for googlebot is untouched — reserved branch does not widen.
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  handleRequest = await loadColdIsolate();
  installFetch([patternsRoute()]);
  const page = await handleRequest(req("/products/widget", GOOGLEBOT), env, ctx);
  await drain();
  assert.equal(await page.text(), "origin page");
  assert.equal(page.headers.get("x-norg-edge"), null);
});
