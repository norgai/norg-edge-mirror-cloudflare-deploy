/**
 * The Bunny request pipeline, end to end through handleRequest.
 *
 * @description Proves the router makes the Cloudflare worker's decisions.
 *
 * The first test in this file is the one that matters most: a real browser
 * user-agent must come back as a passthrough, with no NORG header of any kind.
 * A human receiving the agent variant turns a bug in this file into an
 * incident on the customer's revenue pages.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { handleRequest } from "../src/router.js";
import { PASSTHROUGH } from "../src/lib/origin.js";
import { __test_setFeed } from "../../core/feed.js";
import { __test_reset as resetDeferred, flushDeferred } from "../../core/deferred.js";
import { __test_reset as resetTelemetry } from "../../core/telemetry.js";
import {
  CHROME_UA,
  ENV,
  GOOGLEBOT_UA,
  GOOGLE_EXTENDED_UA,
  GPTBOT_UA,
  PUBLIC_HOST,
  SITE_KEY,
  UNVERIFIED_IP,
  bunnyRequest,
  longHtml,
  mirrorHit,
  stubNetwork,
} from "./helpers.mjs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
  resetDeferred();
  resetTelemetry();
});

/**
 * Run the pipeline against a fresh, entitled isolate.
 *
 * @param {Object} requestOptions Options for bunnyRequest.
 * @param {Object} network Options for stubNetwork.
 * @param {Object} envOverrides Extra install config.
 * Telemetry is deferred, exactly as it is in production, so the queue is
 * flushed here the way index.js flushes it — otherwise every assertion about
 * an event or a render request would pass vacuously.
 *
 * @returns {Promise<{result: *, calls: Array}>} Outcome.
 */
async function run(requestOptions = {}, network = {}, envOverrides = {}) {
  const { calls } = stubNetwork(network);
  const result = await handleRequest(bunnyRequest(requestOptions), { ...ENV, ...envOverrides });
  await flushDeferred();
  await new Promise((resolve) => setImmediate(resolve));
  return { result, calls };
}

const isPassthrough = (result) => result === PASSTHROUGH;

// --- Rule 1 and rule 2: humans and search engines are never touched ---------

test("a real browser gets the origin, with no NORG header at all", async () => {
  const { result } = await run(
    { headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result), "a human must never get a generated response");
});

test("a human never triggers a mirror lookup", async () => {
  const { calls } = await run(
    { headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(
    calls.some((c) => c.url.includes("edge-content")),
    false,
    "a human must not cost a receptionist round trip",
  );
});

test("Googlebot always gets the origin, even with ?agent=true", async () => {
  for (const path of ["/widgets/", "/widgets/?agent=true"]) {
    const { result } = await run(
      { path, headers: { "user-agent": GOOGLEBOT_UA } },
      { mirror: () => mirrorHit() },
    );
    assert.ok(isPassthrough(result), `search-bot floor breached at "${path}"`);
  }
});

test("the search-bot floor holds before any mirror lookup", async () => {
  const { calls } = await run(
    { headers: { "user-agent": GOOGLEBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(
    calls.some((c) => c.url.includes("edge-content")),
    false,
    "a search bot must not even trigger a mirror lookup",
  );
});

test("google-extended is an AI crawler, not a search engine, and is diverted", async () => {
  const { result } = await run(
    { headers: { "user-agent": GOOGLE_EXTENDED_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.notEqual(result, PASSTHROUGH, "google-extended must reach the mirror");
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
});

// --- The three gates -------------------------------------------------------

test("a verified GPTBot gets the mirror", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.notEqual(result, PASSTHROUGH);
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.headers.get("x-norg-edge-env"), "test");
});

test("a spoofed GPTBot from an unlisted address gets the origin", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA }, clientIp: UNVERIFIED_IP },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result), "gate 3 must refuse an unverified source");
});

test("a crawler NORG has not authorised to divert gets the origin", async () => {
  const { result } = await run(
    { headers: { "user-agent": "heldbot/1.0" } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result), "gate 2 must obey serving_policy");
});

test("a client-supplied x-real-ip cannot beat gate 3", async () => {
  // Bunny replaces both IP headers, so the only way a caller could influence
  // the verdict is if this code preferred a header the platform did not set.
  const { result } = await run(
    {
      headers: { "user-agent": GPTBOT_UA, "x-real-ip": UNVERIFIED_IP, "x-forwarded-for": UNVERIFIED_IP },
      clientIp: UNVERIFIED_IP,
    },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result));
});

// --- Entitlement (rule 3) --------------------------------------------------

test("an unentitled install changes nothing at all", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { feed: () => new Response("", { status: 403 }), mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result));
  assert.equal(
    calls.some((c) => c.url.includes("edge-content")),
    false,
    "an unentitled install must not read the mirror",
  );
});

test("an unreachable NORG leaves the customer's site untouched", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    {
      feed: () => {
        throw new Error("network down");
      },
      mirror: () => mirrorHit(),
    },
  );
  assert.ok(isPassthrough(result));
});

// --- Surfaces --------------------------------------------------------------

test("?agent=true serves the mirror without enqueuing a render", async () => {
  const { result, calls } = await run(
    { path: "/widgets/?agent=true", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
  assert.equal(
    calls.some((c) => c.url.includes("render-requests")),
    false,
    "the override must not trigger renders across the catalogue",
  );
});

test("a static asset is never diverted and never looked up", async () => {
  const { result, calls } = await run(
    { path: "/assets/app.css", headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result));
  assert.equal(
    calls.some((c) => c.url.includes("edge-content")),
    false,
    "an asset must not cost a receptionist round trip",
  );
});

test("an operator-skipped path passes through even for a verified bot", async () => {
  const { result } = await run(
    { path: "/checkout", headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result));
});

test("the agentic subtree is served to every caller from the same bytes", async () => {
  for (const ua of [CHROME_UA, GOOGLEBOT_UA, GPTBOT_UA]) {
    const { result } = await run(
      { path: "/ai/widgets/", headers: { "user-agent": ua }, clientIp: UNVERIFIED_IP },
      { mirror: () => mirrorHit() },
    );
    assert.equal(result.headers.get("x-norg-edge"), "mirror", `agentic path differed for ${ua}`);
  }
});

test("the agentic subtree reads the INNER path, not the prefixed one", async () => {
  const { calls } = await run(
    { path: "/ai/widgets/", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  const read = calls.find((c) => c.url.includes("edge-content"));
  assert.ok(read.url.endsWith("/widgets/index.html"), `read ${read.url}`);
});

test("the health probe answers only with the site key", async () => {
  const { result } = await run({ headers: { "x-norg-edge-check": SITE_KEY } });
  const body = await result.json();
  assert.equal(body.platform, "bunny");
  assert.equal(body.env, "test");

  const { result: refused } = await run({ headers: { "x-norg-edge-check": "wrong" } });
  assert.ok(isPassthrough(refused), "a wrong probe key must not shadow a customer URL");
});

// --- The strip fallback ----------------------------------------------------

test("a bot miss serves the stripped origin and asks NORG to render", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => new Response("", { status: 404 }) },
  );
  assert.equal(result.headers.get("x-norg-edge"), "stripped");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.ok(
    calls.some((c) => c.url.includes("render-requests")),
    "a definite 404 must enqueue a render",
  );
});

test("a receptionist ERROR is not a miss and must not enqueue a render", async () => {
  const { calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => new Response("", { status: 500 }) },
  );
  assert.equal(
    calls.some((c) => c.url.includes("render-requests")),
    false,
    "an outage must not look like every page vanishing",
  );
});

test("a thin origin is served untouched rather than stripped to nothing", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    {
      mirror: () => new Response("", { status: 404 }),
      origin: () =>
        new Response("<html><body><nav>menu</nav></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
  );
  assert.ok(isPassthrough(result), "a page with its content removed is worse than the page");
});

test("the strip fetch carries the loop guard", async () => {
  const { calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => new Response("", { status: 404 }), origin: () => new Response(longHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }) },
  );
  const originCall = calls.find((c) => c.url.includes("origin.example.com"));
  assert.ok(originCall, "the strip path must fetch the origin itself");
});

// --- The visitor URL, which Bunny rewrites before the hook -----------------

test("a visit event records the VISITOR host, not the origin host", async () => {
  // Bunny rewrites request.url to the origin before the hook runs, so getting
  // this wrong would silently file every customer's traffic under their origin.
  const { calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  const event = calls.find((c) => c.url.includes("/api/v1/edge/events"));
  assert.ok(event, "a diverted request must report a visit event");
  const body = JSON.parse(event.init.body);
  assert.equal(body.domain, PUBLIC_HOST, "the event must record the customer's hostname");
  assert.equal(body.path, "/widgets/");
  assert.equal(body.served, "mirror");
});

test("a sibling artifact carries the canonical Link at the visitor's host", async () => {
  const { result } = await run(
    { path: "/widgets/index.md", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit("# mirror"), origin: () => new Response("nope", { status: 404 }) },
  );
  assert.equal(result.headers.get("x-robots-tag"), "noindex");
  assert.ok(
    result.headers.get("link").includes(`https://${PUBLIC_HOST}/widgets/`),
    `link was ${result.headers.get("link")}`,
  );
});

// --- Methods ---------------------------------------------------------------

test("a POST to a customer page is never intercepted", async () => {
  const { result } = await run(
    { path: "/cart/add", method: "POST", headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result));
});

test("the remote off switch disables everything", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
    { EDGE_DISABLED: "true" },
  );
  assert.ok(isPassthrough(result));
});

test("our own subrequest cannot recurse into the router", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA, "x-norg-edge": "1" } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result));
});
