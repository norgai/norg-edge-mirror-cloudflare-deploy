/**
 * Outbound control calls: events, heartbeats and render requests.
 *
 * @description Pins that telemetry is deferred, throttled and never blocking.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import {
  __test_reset as resetTelemetry,
  logEdgeEvent,
  maybeHeartbeat,
  requestRender,
} from "../../core/telemetry.js";
import {
  __test_reset as resetDeferred,
  __test_state as deferredState,
  flushDeferred,
} from "../../core/deferred.js";
import { RENDER_DEDUP_MAX_ENTRIES } from "../../core/constants.mjs";

const ENV = {
  SITE_ID: "site-1",
  NORG_SITE_KEY: "k",
  // Stamped by the provider adapter; core reads both from the config object.
  EDGE_SCRIPT_VERSION: "0.2.0",
  EDGE_PLATFORM: "cloudfront",
};
const BOT = { is_ai_bot: true, bot_name: "GPTBot", company: "OpenAI", purpose: "training" };

const realFetch = globalThis.fetch;
let posts = [];

/**
 * Capture every control call as a parsed body.
 *
 * @returns {void}
 */
function captureFetch() {
  posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

/**
 * Flush deferred work and let it settle.
 *
 * @returns {Promise<void>} Resolves once background calls have run.
 */
async function settle() {
  await flushDeferred();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Build a request with the given headers.
 *
 * @param {Object} headers Header map.
 * @returns {Request} Request for https://shop.example.com/widgets/.
 */
const requestWith = (headers = {}) =>
  new Request("https://shop.example.com/widgets/", { headers });

afterEach(() => {
  globalThis.fetch = realFetch;
  resetTelemetry();
  resetDeferred();
});

test("an event is queued, not sent, on the visitor's path", async () => {
  captureFetch();
  logEdgeEvent(ENV, requestWith(), BOT, "mirror", null, 200);

  assert.equal(posts.length, 0, "telemetry must never block the response");
  assert.equal(deferredState().pending, 1);

  await settle();
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/v1\/edge\/events$/);
});

test("a diverted event carries the classification and the real customer domain", async () => {
  captureFetch();
  logEdgeEvent(ENV, requestWith(), BOT, "mirror", 850, 200);
  await settle();

  assert.deepEqual(posts[0].body, {
    domain: "shop.example.com",
    path: "/widgets/",
    user_agent: null,
    is_ai_bot: true,
    bot_name: "GPTBot",
    company: "OpenAI",
    purpose: "training",
    served: "mirror",
    raw_word_count: 850,
    response_status: 200,
    ip_country: null,
    ip_city: null,
    asn: null,
    as_organization: null,
    colo: null,
    http_protocol: null,
    tls_version: null,
  });
});

test("CloudFront viewer headers populate the geo fields", async () => {
  captureFetch();
  logEdgeEvent(
    ENV,
    requestWith({
      "cloudfront-viewer-country": "AU",
      "cloudfront-viewer-city": "Melbourne",
      "cloudfront-viewer-asn": "13335",
      "cloudfront-viewer-http-version": "2.0",
      "cloudfront-viewer-tls": "TLSv1.3",
    }),
    BOT,
    "mirror",
  );
  await settle();

  assert.equal(posts[0].body.ip_country, "AU");
  assert.equal(posts[0].body.ip_city, "Melbourne");
  assert.equal(posts[0].body.asn, "13335");
  assert.equal(posts[0].body.http_protocol, "2.0");
  assert.equal(posts[0].body.tls_version, "TLSv1.3");
});

for (const served of ["origin", "origin_thin"]) {
  test(`a "${served}" passthrough event is suppressed by default`, async () => {
    captureFetch();
    logEdgeEvent(ENV, requestWith(), BOT, served);
    await settle();
    assert.equal(posts.length, 0, "human traffic must not carry a NORG round trip");
  });
}

test("passthrough events are sent when the install opts in", async () => {
  captureFetch();
  logEdgeEvent({ ...ENV, EDGE_EVENTS_VERBOSE: "true" }, requestWith(), BOT, "origin");
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.served, "origin");
});

test("a diverted event is always sent, verbose or not", async () => {
  captureFetch();
  for (const served of ["mirror", "stripped", "agentic_path", "agent_param_override"]) {
    logEdgeEvent(ENV, requestWith(), BOT, served);
  }
  await settle();
  assert.equal(posts.length, 4);
});

test("traffic heartbeats are throttled per container", async () => {
  captureFetch();
  maybeHeartbeat(ENV, "traffic");
  maybeHeartbeat(ENV, "traffic");
  maybeHeartbeat(ENV, "traffic");
  await settle();

  assert.equal(posts.length, 1, "only the first traffic beat in the window is sent");
  assert.equal(posts[0].body.trigger, "traffic");
  assert.equal(posts[0].body.platform, "cloudfront");
});

test("a cron heartbeat is never throttled", async () => {
  captureFetch();
  maybeHeartbeat(ENV, "traffic");
  maybeHeartbeat(ENV, "cron");
  maybeHeartbeat(ENV, "cron");
  await settle();

  assert.equal(posts.length, 3, "the cron beat is the liveness signal and must always land");
});

test("a heartbeat reports the version, the bound env and the platform", async () => {
  captureFetch();
  maybeHeartbeat({ ...ENV, EDGE_ENV: "test" }, "cron");
  await settle();

  assert.match(posts[0].body.script_version, /^\d+\.\d+\.\d+$/);
  assert.equal(posts[0].body.env, "test");
  assert.equal(posts[0].body.platform, "cloudfront");
});

test("a heartbeat with no bound env reports unknown, never a guess", async () => {
  captureFetch();
  maybeHeartbeat(ENV, "cron");
  await settle();
  assert.equal(posts[0].body.env, "unknown");
});

test("a render request is deduped per path within the container window", async () => {
  captureFetch();
  const url = new URL("https://shop.example.com/widgets/");
  requestRender(ENV, url);
  requestRender(ENV, url);
  requestRender(ENV, new URL("https://shop.example.com/other/"));
  await settle();

  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((p) => p.body.path).sort(),
    ["/other/", "/widgets/"],
  );
  assert.equal(posts[0].body.reason, "bot_miss");
});

test("the render dedup map is bounded", async () => {
  captureFetch();
  for (let i = 0; i < RENDER_DEDUP_MAX_ENTRIES + 50; i += 1) {
    requestRender(ENV, new URL(`https://shop.example.com/page-${i}/`));
  }
  await settle();

  // Every distinct path is still requested once; the cap governs retained
  // memory, not whether a request is made.
  assert.equal(posts.length, RENDER_DEDUP_MAX_ENTRIES + 50);

  // The earliest paths have been evicted, so they would be requested again.
  requestRender(ENV, new URL("https://shop.example.com/page-0/"));
  await settle();
  assert.equal(posts.length, RENDER_DEDUP_MAX_ENTRIES + 51);
});

test("a failing control call never escapes to the caller", async () => {
  globalThis.fetch = async () => {
    throw new Error("NORG unreachable");
  };
  logEdgeEvent(ENV, requestWith(), BOT, "mirror");
  maybeHeartbeat(ENV, "cron");
  await settle();
  // Reaching here without a rejection is the assertion.
  assert.ok(true);
});
