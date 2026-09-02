/**
 * Edge-router worker — response-cache degrade + gating edges.
 *
 * Run with: node --test edge-router-worker.response-cache-degrade.test.mjs
 *
 * Closes the acceptance criteria the happy-path suite leaves open: a changed
 * content_version invalidates the old key (AC4), an evicted/expired entry
 * refetches (AC5), a cache.put/cache.match failure degrades to today's serve
 * (AC7/AC8), and the response cache is NEVER consulted for a request that the
 * search-bot floor passes through (AC11) — proving the cache lives strictly
 * downstream of classification.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  __test_serveAgent as serveAgent,
  __test_handleRequest as handleRequest,
  __test_responseCacheContext as responseCacheContext,
  __test_cacheableMirror as cacheableMirror,
  __test_pathToKeySuffix as pathToKeySuffix,
} from "./edge-router-worker.js";

const RC_PREFIX = "https://norg-edge.internal/rc/";
const CONTENT_HOST = "edge-content.norg.test";

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: `https://${CONTENT_HOST}`,
  NORG_SITE_KEY: "nek_live_secret",
};

const classification = { is_ai_bot: true, purpose: "agent" };
const enabledFeed = {
  entitled: true,
  responseCache: { enabled: true, ttl: 120 },
  contentVersion: "v1",
};

/**
 * Cache API stand-in storing real Response bytes. `failPut`/`failMatch` force
 * the documented Cache API rejections so the degrade paths can be exercised.
 */
class FakeCache {
  constructor({ failPut = false, failMatch = false } = {}) {
    this.store = new Map();
    this.failPut = failPut;
    this.failMatch = failMatch;
  }
  async match(req) {
    if (this.failMatch) throw new Error("cache match boom");
    const e = this.store.get(req.url);
    return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
  }
  async put(req, res) {
    if (this.failPut) throw new Error("cache put boom");
    const headers = {};
    for (const [k, v] of res.headers) headers[k] = v;
    this.store.set(req.url, { body: await res.text(), headers });
  }
  async delete(req) {
    return this.store.delete(req.url);
  }
  rcKeys() {
    return [...this.store.keys()].filter((k) => k.startsWith(RC_PREFIX));
  }
}

let contentFetches;
let waitUntilTasks;
const ctx = { waitUntil: (p) => waitUntilTasks.push(p) };

/** 200 mirror HTML from the receptionist; 200 for the feed / logEdgeEvent. */
function installFetch(feedBody = null) {
  globalThis.fetch = async (input) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes("/api/v1/edge/bot-patterns")) {
      return new Response(JSON.stringify(feedBody || {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.includes(CONTENT_HOST)) {
      contentFetches += 1;
      return new Response("<html>MIRROR</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("ORIGIN", { status: 200 });
  };
}

function agentRequest(ua = "GPTBot/1.0") {
  const req = new Request("https://shop.example/widgets", {
    headers: { "user-agent": ua },
  });
  req.cf = { country: "AU", verifiedBotCategory: "AI Crawler" };
  return req;
}

beforeEach(() => {
  contentFetches = 0;
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  installFetch();
});

// --- AC4: a new content_version yields a new key and refetches -------------

test("AC4: two content_versions produce different keys", () => {
  const suffix = pathToKeySuffix("/widgets");
  const k1 = responseCacheContext(env, { ...enabledFeed, contentVersion: "v1" }, suffix).key;
  const k2 = responseCacheContext(env, { ...enabledFeed, contentVersion: "v2" }, suffix).key;
  // AC4: publish bumps content_version -> distinct key -> old entry not served.
  assert.notEqual(k1, k2);
  assert.ok(k1.includes("/v1/") && k2.includes("/v2/"));
});

test("AC4: an entry stored under v1 is not served after the version bumps to v2", async () => {
  const url = new URL("https://shop.example/widgets");
  const v1Key = `${RC_PREFIX}site-123/v1${pathToKeySuffix("/widgets")}`;
  await globalThis.caches.default.put(
    new Request(v1Key),
    cacheableMirror(
      new Response("<html>STALE-V1</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      120,
    ),
  );
  const res = await serveAgent(
    agentRequest(), env, ctx, url, classification,
    { ...enabledFeed, contentVersion: "v2" },
  );
  const body = await res.text();
  // AC4: the v2 request misses the v1 entry and refetches fresh origin bytes.
  assert.equal(body, "<html>MIRROR</html>");
  assert.equal(contentFetches, 1);
});

// --- AC5: an expired / evicted entry is a miss and refetches ---------------

test("AC5: an entry no longer present (past its s-maxage) is refetched from origin", async () => {
  const url = new URL("https://shop.example/widgets");
  // The platform drops the entry once s-maxage elapses; the worker then sees a
  // miss (cache.match -> undefined) and refetches — never serving stale bytes.
  const res = await serveAgent(agentRequest(), env, ctx, url, classification, enabledFeed);
  await Promise.all(waitUntilTasks);
  // AC5: TTL is the only staleness bound — an absent entry refills fresh.
  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(contentFetches, 1);
});

test("AC5: cacheableMirror stamps s-maxage equal to the feed ttl (the expiry bound)", () => {
  const norg = new Response("x", { headers: { "content-type": "text/html" } });
  // AC5: worst-case staleness is bounded by this TTL alone.
  assert.equal(cacheableMirror(norg, 120).headers.get("Cache-Control"), "s-maxage=120");
  assert.equal(cacheableMirror(norg, 30).headers.get("Cache-Control"), "s-maxage=30");
});

// --- AC7 / AC8: cache failures degrade to today's exact serve --------------

test("AC7: a cache.put failure still serves the correct mirror, no error surfaced", async () => {
  globalThis.caches = { default: new FakeCache({ failPut: true }) };
  const url = new URL("https://shop.example/widgets");
  const res = await serveAgent(agentRequest(), env, ctx, url, classification, enabledFeed);
  // The put runs behind ctx.waitUntil; awaiting it must not reject (swallowed).
  await Promise.all(waitUntilTasks);
  const body = await res.text();
  // AC7: a cache write failure never turns a successful serve into an error.
  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(body, "<html>MIRROR</html>");
  assert.equal(contentFetches, 1);
});

test("AC8: a cache.match failure falls through to the origin fetch path", async () => {
  globalThis.caches = { default: new FakeCache({ failMatch: true }) };
  const url = new URL("https://shop.example/widgets");
  const res = await serveAgent(agentRequest(), env, ctx, url, classification, enabledFeed);
  // AC8: a read failure degrades to the normal fetchFromNorg serve.
  assert.equal(res.headers.get("X-Norg-Edge"), "mirror");
  assert.equal(contentFetches, 1);
});

// --- AC11: the search-bot floor is upstream of the cache -------------------

test("AC11: a traditional search bot passes through and never writes an rc/ key", async () => {
  installFetch({
    patterns: [{ pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" }],
    cache_ttl: 3600,
    cidr_ranges: {},
    content_version: "v1",
    response_cache: { enabled: true, ttl: 120 },
  });
  const req = new Request("https://shop.example/widgets", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
  });
  req.cf = { country: "US" };
  const res = await handleRequest(req, env, ctx);
  const body = await res.text();
  // AC11: the search-bot floor returns the origin BEFORE serveAgent, so the
  // response cache (rc/ keys) is never consulted even with the cache enabled.
  assert.equal(body, "ORIGIN");
  assert.equal(globalThis.caches.default.rcKeys().length, 0);
});
