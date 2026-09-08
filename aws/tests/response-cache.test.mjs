/**
 * The per-container mirror cache.
 *
 * @description Bypass rules, expiry, bounds, and that failure is never fatal.
 *
 * The contract worth pinning is the one the platform forced: a CloudFront hit
 * is answered before the function and so records nothing, which is why every
 * mirror stays no-store at the CDN. This cache lives INSIDE the function, so a
 * hit still classifies and still logs. The pipeline suite proves the logging
 * half; this file proves the store behaves.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import {
  __resetResponseCache,
  __responseCacheStats,
  cacheContext,
  readCached,
  writeCached,
} from "../lambda/lib/response-cache.js";

const ENV = { SITE_ID: "site-1" };
const FEED = { responseCache: { enabled: true, ttl: 300 }, contentVersion: "v9" };
const body = (n = 32) => Buffer.alloc(n, "x");

afterEach(() => __resetResponseCache());

test("the key folds site, content version and path", () => {
  const ctx = cacheContext(ENV, FEED, "/about/index.html");
  assert.equal(ctx.key, "site-1/v9/about/index.html");
  assert.equal(ctx.ttl, 300);
});

test("a publish self-invalidates by yielding a different key", () => {
  const before = cacheContext(ENV, FEED, "/a/index.html").key;
  const after = cacheContext(ENV, { ...FEED, contentVersion: "v10" }, "/a/index.html").key;
  assert.notEqual(before, after);
});

test("bypassed unless NORG enabled it and published a version", () => {
  assert.equal(cacheContext(ENV, { ...FEED, responseCache: { enabled: false } }, "/a"), null);
  assert.equal(cacheContext(ENV, { ...FEED, contentVersion: "" }, "/a"), null);
  assert.equal(cacheContext({}, FEED, "/a"), null);
  assert.equal(cacheContext(ENV, null, "/a"), null);
});

test("a null context reads and writes nothing rather than throwing", () => {
  assert.equal(readCached(null), null);
  writeCached(null, body());
  assert.equal(__responseCacheStats().entries, 0);
});

test("a stored mirror comes back, and comes back repeatedly", async () => {
  const ctx = cacheContext(ENV, FEED, "/a/index.html");
  writeCached(ctx, Buffer.from("<html>MIRROR</html>"), "text/html");

  for (let i = 0; i < 3; i++) {
    const hit = readCached(ctx);
    assert.ok(hit, `read ${i + 1} should hit`);
    assert.match(await hit.text(), /MIRROR/);
    assert.equal(hit.headers.get("content-type"), "text/html");
  }
});

test("a different path is a miss, not another page's bytes", () => {
  writeCached(cacheContext(ENV, FEED, "/a/index.html"), body());
  assert.equal(readCached(cacheContext(ENV, FEED, "/b/index.html")), null);
});

test("an expired entry is a miss and is dropped", () => {
  const ctx = cacheContext(ENV, { ...FEED, responseCache: { enabled: true, ttl: 1 } }, "/a");
  writeCached(ctx, body());

  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    assert.equal(readCached(ctx), null);
  } finally {
    Date.now = realNow;
  }
  assert.equal(__responseCacheStats().entries, 0, "the dead entry is not left behind");
});

test("an oversized page is not stored at all", () => {
  // One huge mirror must not be able to evict everything else.
  writeCached(cacheContext(ENV, FEED, "/big"), Buffer.alloc(300 * 1024));
  assert.equal(__responseCacheStats().entries, 0);
});

test("the container budget is enforced by evicting least-recently-used", () => {
  const mb = 200 * 1024;
  for (let i = 0; i < 100; i++) writeCached(cacheContext(ENV, FEED, `/p${i}`), Buffer.alloc(mb));

  const { bytes } = __responseCacheStats();
  assert.ok(bytes <= 16 * 1024 * 1024, `budget held, was ${bytes}`);
  assert.ok(readCached(cacheContext(ENV, FEED, "/p99")), "the newest survives");
  assert.equal(readCached(cacheContext(ENV, FEED, "/p0")), null, "the oldest was evicted");
});

test("rewriting a key replaces rather than double-counts it", () => {
  const ctx = cacheContext(ENV, FEED, "/a");
  writeCached(ctx, Buffer.alloc(1000));
  writeCached(ctx, Buffer.alloc(1000));
  const { entries, bytes } = __responseCacheStats();
  assert.equal(entries, 1);
  assert.equal(bytes, 1000);
});
