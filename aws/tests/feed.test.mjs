/**
 * The authenticated feed and the entitlement gate.
 *
 * @description Pins the refusal-vs-outage distinction the whole design rests on.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { __test_getFeed, __test_setFeed, getBotFeed, refreshFeed } from "../lambda/lib/feed.js";
import {
  __test_reset as resetDeferred,
  __test_state as deferredState,
  flushDeferred,
} from "../lambda/lib/deferred.js";

const ENV = { SITE_ID: "site-1", NORG_SITE_KEY: "nek_live_key" };

const FEED_BODY = {
  patterns: [{ pattern: "gptbot", company: "OpenAI", purpose: "training", serving_policy: "divert" }],
  cidr_ranges: { openai: { cidrs: ["20.171.0.0/16"] } },
  agentic_path_prefix: "/ai",
  skip_paths: ["/checkout"],
  content_version: "1730000000",
  response_cache: { enabled: true, ttl: 120 },
  cache_ttl: 3600,
};

const realFetch = globalThis.fetch;
let calls = [];

/**
 * Install a stub global fetch returning the given queued responses.
 *
 * @param {Array<function(Request|string, Object): (Response|Error)>} handlers
 *   One handler per expected call; the last is reused if calls exceed it.
 * @returns {void}
 */
function stubFetch(handlers) {
  calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    const result = await handler(url, init);
    if (result instanceof Error) throw result;
    return result;
  };
}

/**
 * A JSON feed response.
 *
 * @param {Object} body Feed payload.
 * @param {Object} headers Extra response headers.
 * @returns {Response} A 200 JSON response.
 */
const feedResponse = (body = FEED_BODY, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
  resetDeferred();
});

test("a cold container with a 200 feed becomes entitled", async () => {
  __test_setFeed(null);
  stubFetch([() => feedResponse()]);

  const feed = await getBotFeed(ENV);

  assert.equal(feed.entitled, true);
  assert.equal(feed.patterns.length, 1);
  assert.deepEqual(feed.skipPaths, ["/checkout"]);
  assert.equal(feed.agenticPathPrefix, "/ai");
  assert.equal(feed.responseCache.ttl, 120);
  assert.equal(calls.length, 1);
});

test("a fresh feed is reused with no second network call", async () => {
  __test_setFeed(null);
  stubFetch([() => feedResponse()]);

  await getBotFeed(ENV);
  await getBotFeed(ENV);

  assert.equal(calls.length, 1, "a fresh entry must not re-probe");
});

for (const status of [401, 403]) {
  test(`a ${status} refusal revokes entitlement the moment the feed is fetched`, async () => {
    __test_setFeed({
      entitled: true, patterns: [{}], cidrRanges: {}, skipPaths: [],
      etag: "", fetchedAt: Date.now() - 10_000, ttl: 1,
    });
    stubFetch([() => new Response("denied", { status })]);

    const { outcome } = await refreshFeed(ENV);

    assert.equal(outcome, "refused");
    assert.equal(
      __test_getFeed().entitled,
      false,
      "a refusal must stop the install diverting at once",
    );
    assert.deepEqual(__test_getFeed().patterns, []);
  });
}

test("a refusal arriving on the DEFERRED refresh revokes the next request", async () => {
  // The stale-entitled path answers from cache and refreshes behind the
  // response — on Cloudflare too — so a revocation lands one request later,
  // not on the request that discovered it. This pins that one-request lag.
  __test_setFeed({
    entitled: true, patterns: [{ pattern: "gptbot" }], cidrRanges: {}, skipPaths: [],
    etag: "", fetchedAt: Date.now() - 10_000, ttl: 1,
  });
  stubFetch([() => new Response("denied", { status: 403 })]);

  const served = await getBotFeed(ENV);
  assert.equal(served.entitled, true, "this request still serves from the stale entry");

  // The flush is non-blocking for a queue this small (that is the point of
  // deferring), so give the background refresh an event-loop turn to land.
  await flushDeferred();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    __test_getFeed().entitled,
    false,
    "the deferred refresh must apply the refusal for the next request",
  );
});

test("a refusal is negative-cached, so a paused site stops probing on every request", async () => {
  __test_setFeed(null);
  stubFetch([() => new Response("", { status: 403 })]);

  await getBotFeed(ENV);
  await getBotFeed(ENV);
  await getBotFeed(ENV);

  assert.equal(calls.length, 1, "the negative verdict must short-circuit later requests");
});

test("an OUTAGE never revokes a working install", async () => {
  const entitled = {
    entitled: true,
    patterns: [{ pattern: "gptbot", serving_policy: "divert" }],
    cidrRanges: {},
    skipPaths: [],
    etag: "",
    // Stale: fetched long ago with a short TTL.
    fetchedAt: Date.now() - 10_000,
    ttl: 1,
  };
  __test_setFeed(entitled);
  stubFetch([() => new Error("ECONNRESET")]);

  const feed = await getBotFeed(ENV);
  assert.equal(feed.entitled, true, "the stale entry answers while NORG is away");

  // And crucially the refresh that follows it, which FAILS, must not revoke.
  await flushDeferred();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    __test_getFeed().entitled,
    true,
    "a timeout says nothing about entitlement and must never revoke a working install",
  );
  assert.equal(__test_getFeed().patterns.length, 1);
});

test("a stale entitled feed is served now and refreshed behind the response", async () => {
  __test_setFeed({
    entitled: true,
    patterns: [{ pattern: "old" }],
    cidrRanges: {},
    skipPaths: [],
    etag: "",
    fetchedAt: Date.now() - 10_000,
    ttl: 1,
  });
  stubFetch([() => feedResponse()]);

  const feed = await getBotFeed(ENV);

  assert.equal(feed.patterns[0].pattern, "old", "the stale entry answers immediately");
  assert.equal(calls.length, 0, "the refresh must not block the visitor");
  assert.equal(deferredState().pending, 1, "the refresh is deferred, not dropped");
});

test("a stale NEGATIVE feed re-probes rather than serving stale", async () => {
  __test_setFeed({
    entitled: false,
    patterns: [],
    cidrRanges: {},
    skipPaths: [],
    fetchedAt: Date.now() - 10_000,
    ttl: 1,
  });
  stubFetch([() => feedResponse()]);

  const feed = await getBotFeed(ENV);

  assert.equal(feed.entitled, true, "re-entitlement must land as soon as NORG allows it");
  assert.equal(calls.length, 1);
});

test("a cold container that cannot reach NORG stays unentitled", async () => {
  __test_setFeed(null);
  stubFetch([() => new Error("ETIMEDOUT")]);

  const feed = await getBotFeed(ENV);

  assert.equal(feed.entitled, false, "no feed means no local fallback and no diverting");
  assert.deepEqual(feed.patterns, []);
});

test("a malformed feed body is treated as unreachable, not as entitlement", async () => {
  __test_setFeed(null);
  stubFetch([() => new Response("not json", { status: 200 })]);

  const feed = await getBotFeed(ENV);
  assert.equal(feed.entitled, false);
});

test("a revalidated feed keeps its entry and restarts the TTL", async () => {
  const original = {
    entitled: true,
    patterns: [{ pattern: "gptbot" }],
    cidrRanges: { openai: { cidrs: ["1.2.3.0/24"] } },
    skipPaths: ["/checkout"],
    etag: 'W/"abc"',
    fetchedAt: Date.now() - 10_000,
    ttl: 1,
  };
  __test_setFeed(original);
  stubFetch([() => new Response(null, { status: 304 })]);

  const { outcome, entry } = await refreshFeed(ENV);

  assert.equal(outcome, "ok");
  assert.equal(entry.entitled, true);
  assert.deepEqual(entry.patterns, original.patterns);
  assert.deepEqual(entry.skipPaths, ["/checkout"]);
  assert.ok(entry.fetchedAt > original.fetchedAt, "the TTL restarts on revalidation");
});

test("If-None-Match is sent only when there is an entry to revalidate", async () => {
  __test_setFeed({
    entitled: true, patterns: [], cidrRanges: {}, skipPaths: [],
    etag: 'W/"abc"', fetchedAt: Date.now() - 10_000, ttl: 1,
  });
  stubFetch([() => feedResponse()]);
  await refreshFeed(ENV);
  assert.equal(calls[0].init.headers["If-None-Match"], 'W/"abc"');

  __test_setFeed(null);
  stubFetch([() => feedResponse()]);
  await refreshFeed(ENV);
  assert.equal(
    "If-None-Match" in calls[0].init.headers,
    false,
    "a cold container has nothing to revalidate against",
  );
});

test("the feed call is authenticated with both credentials", async () => {
  __test_setFeed(null);
  stubFetch([() => feedResponse()]);

  await refreshFeed(ENV);

  assert.equal(calls[0].init.headers["X-Norg-Site-Id"], "site-1");
  assert.equal(calls[0].init.headers["X-Norg-Site-Key"], "nek_live_key");
});

test("a response_cache ttl of 0 survives instead of taking the default", async () => {
  __test_setFeed(null);
  stubFetch([() => feedResponse({ ...FEED_BODY, response_cache: { enabled: true, ttl: 0 } })]);

  const feed = await getBotFeed(ENV);
  assert.equal(feed.responseCache.ttl, 0);
});
