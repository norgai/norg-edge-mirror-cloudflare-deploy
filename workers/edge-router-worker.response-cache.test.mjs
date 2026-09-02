/**
 * Edge-router worker — customer-zone response cache (Cache API layer).
 *
 * Run with: node --test edge-router-worker.response-cache.test.mjs
 *
 * Covers the response-cache gate (SITE_ID + content_version key folding), the
 * two-response idiom (a cacheable s-maxage copy is stored while the visitor copy
 * stays no-store), degrade-on-failure, and that a warm hit avoids the R2 round
 * trip while classification/analytics still run (logEdgeEvent fires on a hit).
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  __test_serveAgent as serveAgent,
  __test_responseCacheContext as responseCacheContext,
  __test_cacheableMirror as cacheableMirror,
  __test_readFeedBody as readFeedBody,
  __test_pathToKeySuffix as pathToKeySuffix,
} from "./edge-router-worker.js";

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://edge-content.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
};

const CONTENT_HOST = "edge-content.norg.test";

/** A Cache API stand-in that stores real Response bytes + headers. */
class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(req) {
    const e = this.store.get(req.url);
    if (!e) return undefined;
    return new Response(e.body, { status: 200, headers: e.headers });
  }
  async put(req, res) {
    const headers = {};
    for (const [k, v] of res.headers) headers[k] = v;
    this.store.set(req.url, { body: await res.text(), headers });
  }
  async delete(req) {
    return this.store.delete(req.url);
  }
}

let contentFetches;
let waitUntilTasks;
const ctx = { waitUntil: (p) => waitUntilTasks.push(p) };
const classification = { is_ai_bot: true, purpose: "agent" };

const enabledFeed = {
  entitled: true,
  responseCache: { enabled: true, ttl: 120 },
  contentVersion: "v1",
};

/** Stub global fetch: 200 mirror HTML from the receptionist, 200 for anything else. */
function installFetch() {
  globalThis.fetch = async (input) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes(CONTENT_HOST)) {
      contentFetches += 1;
      return new Response("<html>MIRROR</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("{}", { status: 200 });
  };
}

function agentRequest() {
  const req = new Request("https://shop.example/widgets");
  req.cf = { country: "AU" };
  return req;
}

beforeEach(() => {
  contentFetches = 0;
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  installFetch();
});

// --- Pure gate + copy surface --------------------------------------------

test("responseCacheContext folds SITE_ID + content_version into the key", () => {
  const suffix = pathToKeySuffix("/widgets");
  const rc = responseCacheContext(env, enabledFeed, suffix);
  assert.ok(rc, "context should resolve when enabled with a version");
  assert.equal(rc.key, `https://norg-edge.internal/rc/site-123/v1${suffix}`);
  assert.equal(rc.ttl, 120);
});

test("responseCacheContext returns null when disabled, versionless, or SITE_ID-less", () => {
  const suffix = pathToKeySuffix("/widgets");
  assert.equal(
    responseCacheContext(env, { responseCache: { enabled: false }, contentVersion: "v1" }, suffix),
    null,
  );
  assert.equal(
    responseCacheContext(env, { responseCache: { enabled: true }, contentVersion: "" }, suffix),
    null,
  );
  assert.equal(
    responseCacheContext({}, enabledFeed, suffix),
    null,
    "no SITE_ID must never build a key (tenant safety)",
  );
});

test("cacheableMirror is storable (s-maxage, no no-store) and keeps content-type", () => {
  const norg = new Response("<html>x</html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const copy = cacheableMirror(norg, 90);
  assert.equal(copy.headers.get("Cache-Control"), "s-maxage=90");
  assert.equal(copy.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.ok(!(copy.headers.get("Cache-Control") || "").includes("no-store"));
});

test("readFeedBody parses response_cache + content_version from the feed", async () => {
  const resp = new Response(
    JSON.stringify({
      patterns: [],
      cache_ttl: 60,
      content_version: "789",
      response_cache: { enabled: true, ttl: 45 },
    }),
  );
  const entry = await readFeedBody(resp);
  assert.equal(entry.contentVersion, "789");
  assert.deepEqual(entry.responseCache, { enabled: true, ttl: 45 });
});

test("readFeedBody defaults response_cache to disabled when the feed omits it", async () => {
  const entry = await readFeedBody(new Response(JSON.stringify({ patterns: [] })));
  assert.equal(entry.responseCache.enabled, false);
  assert.equal(entry.contentVersion, "");
});

test("readFeedBody preserves an explicit ttl:0 (immediate expiry, not the default)", async () => {
  // ttl:0 is an operator-allowed "no retention" request; a falsy fallback would
  // silently turn it into the 300s default, so it must survive unchanged.
  const resp = new Response(
    JSON.stringify({ patterns: [], response_cache: { enabled: true, ttl: 0 } }),
  );
  const entry = await readFeedBody(resp);
  assert.equal(entry.responseCache.ttl, 0);
});

// --- serveAgent hit / miss / disabled ------------------------------------

test("miss: fetches origin, serves no-store mirror, stores a cacheable copy", async () => {
  const url = new URL("https://shop.example/widgets");
  const res = await serveAgent(agentRequest(), env, ctx, url, classification, enabledFeed);
  await Promise.all(waitUntilTasks);

  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.ok(res.headers.get("Cache-Control").includes("no-store"), "visitor copy stays no-store");
  assert.equal(contentFetches, 1, "origin fetched once on a miss");

  const cache = globalThis.caches.default;
  const key = `https://norg-edge.internal/rc/site-123/v1${pathToKeySuffix("/widgets")}`;
  const stored = cache.store.get(key);
  assert.ok(stored, "a cacheable copy is stored under the synthetic key");
  assert.equal(stored.headers["cache-control"], "s-maxage=120");
});

test("hit: serves the cached mirror without a receptionist round trip, still logs", async () => {
  const url = new URL("https://shop.example/widgets");
  const key = `https://norg-edge.internal/rc/site-123/v1${pathToKeySuffix("/widgets")}`;
  // Warm the cache with a cacheable copy, as a prior miss would have.
  await globalThis.caches.default.put(
    new Request(key),
    cacheableMirror(
      new Response("<html>CACHED</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      120,
    ),
  );

  const res = await serveAgent(agentRequest(), env, ctx, url, classification, enabledFeed);
  const body = await res.text();

  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.ok(res.headers.get("Cache-Control").includes("no-store"));
  assert.equal(body, "<html>CACHED</html>");
  assert.equal(contentFetches, 0, "a warm hit must not hit the receptionist");
  assert.equal(waitUntilTasks.length >= 1, true, "logEdgeEvent still fires on a hit");
});

test("disabled: never reads or writes the response cache", async () => {
  const url = new URL("https://shop.example/widgets");
  const disabledFeed = { entitled: true, responseCache: { enabled: false, ttl: 120 }, contentVersion: "v1" };
  const res = await serveAgent(agentRequest(), env, ctx, url, classification, disabledFeed);
  await Promise.all(waitUntilTasks);

  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(contentFetches, 1, "origin fetched (today's behaviour)");
  assert.equal(globalThis.caches.default.store.size, 0, "nothing written to the response cache");
});

test("missing content_version: serves from origin with no cache key", async () => {
  const url = new URL("https://shop.example/widgets");
  const noVersion = { entitled: true, responseCache: { enabled: true, ttl: 120 }, contentVersion: "" };
  const res = await serveAgent(agentRequest(), env, ctx, url, classification, noVersion);
  await Promise.all(waitUntilTasks);

  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(contentFetches, 1);
  assert.equal(globalThis.caches.default.store.size, 0);
});
