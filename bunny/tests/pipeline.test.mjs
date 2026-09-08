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
import { __test_getFeed, __test_setFeed } from "../../core/feed.js";
import {
  CHROME_UA,
  CONTENT_BASE,
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
});

/**
 * Run the pipeline against a fresh, entitled isolate.
 *
 * Background work is handed to `env.EDGE_KEEPALIVE`, exactly as index.js hands
 * it to Bunny's waitUntil; the promises are collected here so a test can wait
 * for them the way the platform would.
 *
 * @param {Object} requestOptions Options for bunnyRequest.
 * @param {Object} network Options for stubNetwork.
 * @param {Object} envOverrides Extra install config.
 * @returns {Promise<{result: *, calls: Array, held: Array<Promise>}>} Outcome.
 */
async function run(requestOptions = {}, network = {}, envOverrides = {}) {
  const { calls } = stubNetwork(network);
  const held = [];
  const env = { ...ENV, ...envOverrides, EDGE_KEEPALIVE: (p) => held.push(p) };
  const result = await handleRequest(bunnyRequest(requestOptions), env);
  return { result, calls, held };
}

/**
 * The visit document a receptionist fetch carried, decoded.
 *
 * @param {Array} calls Recorded fetch calls.
 * @returns {?Object} The decoded X-Norg-Visit document, or null.
 */
function visitOn(calls) {
  const call = calls.find((c) => c.url.startsWith(CONTENT_BASE));
  const raw = call && new Headers(call.init.headers).get("x-norg-visit");
  return raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : null;
}

/**
 * The headers a receptionist fetch carried.
 *
 * @param {Array} calls Recorded fetch calls.
 * @returns {?Headers} The headers, or null when the receptionist was not called.
 */
function receptionistHeaders(calls) {
  const call = calls.find((c) => c.url.startsWith(CONTENT_BASE));
  return call ? new Headers(call.init.headers) : null;
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

test("a human on an ordinary page makes no call at all", async () => {
  // The fast path: no feed, no mirror, no NORG. On this platform every page
  // request invokes the script, so this is what keeps a person from paying.
  for (const path of ["/", "/widgets/", "/aircraft/", "/blog/2026/post"]) {
    const { result, calls } = await run(
      { path, headers: { "user-agent": CHROME_UA } },
      { mirror: () => mirrorHit() },
    );
    assert.ok(isPassthrough(result), path);
    assert.deepEqual(calls, [], `${path}: a human must not cost any round trip`);
  }
});

test("a human on a NORG surface still runs the real sequence", async () => {
  for (const path of ["/ai/widgets/", "/llms.txt", "/about/index.md", "/.well-known/mcp.json"]) {
    __test_setFeed(null);
    const { calls } = await run(
      { path, headers: { "user-agent": CHROME_UA } },
      { mirror: () => mirrorHit(), origin: () => new Response("", { status: 404 }) },
    );
    assert.ok(calls.some((c) => c.url.includes("bot-patterns")), `${path}: the feed decides entitlement here`);
  }
});

test("anything that might be an agent leaves the fast path", async () => {
  const shapes = [
    { name: "bot-shaped user agent", headers: { "user-agent": GPTBOT_UA } },
    { name: "no user agent", headers: { "user-agent": "" } },
    { name: "a Web Bot Auth signature on a Chrome UA", headers: { "user-agent": CHROME_UA, "signature-agent": '"https://chatgpt.com"' } },
    { name: "the ?agent=true override", headers: { "user-agent": CHROME_UA }, path: "/widgets/?agent=true" },
  ];
  for (const { name, headers, path = "/widgets/" } of shapes) {
    __test_setFeed(null);
    const { calls } = await run({ path, headers }, { mirror: () => mirrorHit() });
    assert.ok(calls.some((c) => c.url.includes("bot-patterns")), `${name}: must reach the feed`);
  }
});

test("a verbose human passthrough event is handed to the keep-alive, never awaited", async () => {
  let resolveEvent;
  const settled = new Promise((resolve) => {
    resolveEvent = resolve;
  });
  const { result, calls, held } = await run(
    { headers: { "user-agent": CHROME_UA } },
    {
      control: async () => {
        await settled;
        return new Response("{}", { status: 200 });
      },
    },
    { EDGE_EVENTS_VERBOSE: "true" },
  );
  assert.ok(isPassthrough(result), "the handler returned while the event was still in flight");
  assert.equal(calls.filter((c) => c.url.includes("/api/v1/edge/events")).length, 1);
  assert.equal(held.length, 1, "Bunny's waitUntil holds the isolate open for it");
  resolveEvent();
  await Promise.all(held);
});

test("a search crawler on an ordinary page makes no call either", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GOOGLEBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthrough(result));
  assert.deepEqual(calls, []);
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

test("?agent=true serves the mirror and declares its own labels, asking for no render", async () => {
  const { result, calls } = await run(
    { path: "/widgets/?agent=true", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
  assert.equal(visitOn(calls).served, "agent_param_override");
  assert.equal(visitOn(calls).served_on_miss, "agent_param_override_miss");
  assert.equal(
    receptionistHeaders(calls).get("x-norg-lazy-render"),
    null,
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
  assert.equal(visitOn(calls).served, "agentic_path");
  assert.equal(visitOn(calls).served_on_miss, "agentic_path_miss");
  assert.equal(visitOn(calls).is_ai_bot, false, "addressed by URL, not by caller");
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

test("a bot miss serves the stripped origin and asks the receptionist to enqueue the render", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => new Response("", { status: 404 }) },
  );
  assert.equal(result.headers.get("x-norg-edge"), "stripped");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  // The render request is not a call of the router's own: the mirror fetch it
  // was going to make anyway carries the ask, and the receptionist enqueues it.
  assert.equal(receptionistHeaders(calls).get("x-norg-lazy-render"), "1");
  assert.equal(visitOn(calls).served_on_miss, "stripped");
  assert.equal(
    calls.some((c) => c.url.includes("render-requests") || c.url.includes("/api/v1/edge/events")),
    false,
    "the router makes no background call",
  );
});

test("LAZY_RENDER_ENABLED=false serves the strip without asking for a render", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => new Response("", { status: 404 }) },
    { LAZY_RENDER_ENABLED: "false" },
  );
  assert.equal(result.headers.get("x-norg-edge"), "stripped");
  assert.equal(receptionistHeaders(calls).get("x-norg-lazy-render"), null);
});

test("STRIP_FALLBACK_ENABLED=false is declared to the receptionist as an origin miss", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => new Response("", { status: 404 }) },
    { STRIP_FALLBACK_ENABLED: "false" },
  );
  assert.ok(isPassthrough(result));
  assert.equal(visitOn(calls).served_on_miss, "origin");
});

test("a receptionist refusal changes nothing on this request and revokes the next", async () => {
  const first = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => new Response("unauthorized", { status: 401 }) },
  );
  assert.ok(isPassthrough(first.result), "no strip for a refused install");
  assert.equal(__test_getFeed().entitled, false, "a 401 from NORG is a refusal, wherever it arrives");

  const second = await run({ headers: { "user-agent": GPTBOT_UA } }, { mirror: () => mirrorHit() });
  assert.ok(isPassthrough(second.result));
  assert.deepEqual(second.calls, [], "unentitled, and negative-cached: no NORG call at all");
});

test("a stale feed refreshes behind the response through the keep-alive", async () => {
  __test_setFeed({
    entitled: true,
    patterns: [{ pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" }],
    cidrRanges: { openai: { cidrs: ["20.171.0.0/16"] } },
    skipPaths: [],
    agenticPathPrefix: "/ai",
    etag: "",
    fetchedAt: Date.now() - 10_000,
    ttl: 1,
  });
  const before = __test_getFeed().fetchedAt;
  const { result, held } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(result.headers.get("x-norg-edge"), "mirror", "the stale entry answered at once");
  assert.equal(held.length, 1, "the refresh went to Bunny's waitUntil");
  await Promise.all(held);
  assert.ok(__test_getFeed().fetchedAt > before, "and landed behind the response");
});

test("an origin error on the strip path is served by passthrough, never relayed", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    {
      mirror: () => new Response("", { status: 404 }),
      origin: () => new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } }),
    },
  );
  assert.ok(isPassthrough(result));
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

test("a verified agent visit is recorded by the receptionist, never by the router", async () => {
  // Bunny rewrites request.url to the origin before the hook runs; the visit
  // header is built from the visitor-facing view, and NORG's content service
  // records it against the site it authenticated.
  const { calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(calls.some((c) => c.url.includes("/api/v1/edge/events")), false, "no event call from the router");
  const visit = visitOn(calls);
  assert.equal(visit.user_agent, GPTBOT_UA);
  assert.equal(visit.is_ai_bot, true);
  assert.equal(visit.bot_name, "gptbot");
  assert.equal(visit.company, "openai");
  assert.equal(visit.served, "mirror");
  // Bunny publishes geo under cdn-* names that core does not read, so the
  // header carries none — recorded null, never guessed.
  assert.equal("ip_country" in visit, false);
});

test("the canonical Link on a sibling names the VISITOR host, not the origin", async () => {
  // Getting the visitor URL wrong would file every customer's traffic under
  // their origin's hostname; the sibling's Link header proves the view.
  const { result } = await run(
    { path: "/widgets/index.md", headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit("# mirror"), origin: () => new Response("nope", { status: 404 }) },
  );
  assert.ok(result.headers.get("link").includes(`https://${PUBLIC_HOST}/widgets/`));
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
