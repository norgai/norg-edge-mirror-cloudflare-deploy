/**
 * The human fast path: a person never waits on NORG or AWS.
 *
 * @description Proves an ordinary page view makes no lookup of any kind.
 *
 * On this provider every page request invokes the router, so the cost of a
 * lookup lands on a human unless the router answers them first. These tests
 * pin that it does, and that everything which might be an agent still runs
 * the real sequence.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { handler } from "../lambda/edge-router-lambda.js";
import { __test_setFeed } from "../../core/feed.js";
import { isOrdinaryBrowser } from "../../core/paths.js";
import {
  CHROME_UA,
  GOOGLEBOT_UA,
  GPTBOT_UA,
  cloudFrontEvent,
  header,
  isPassthroughResult,
  mirrorHit,
  stubNetwork,
} from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
});

test("an ordinary browser on an ordinary page makes no call at all", async () => {
  for (const uri of ["/", "/widgets/", "/aircraft/", "/blog/2026/post"]) {
    const { calls } = stubNetwork({ mirror: () => mirrorHit() });
    const result = await handler(cloudFrontEvent({ uri, headers: { "user-agent": CHROME_UA } }));
    assert.ok(isPassthroughResult(result), uri);
    assert.deepEqual(calls, [], `${uri}: a human must not pay for the feed or the mirror`);
  }
});

test("a search crawler on an ordinary page makes no call either", async () => {
  const { calls } = stubNetwork({ mirror: () => mirrorHit() });
  const result = await handler(cloudFrontEvent({ headers: { "user-agent": GOOGLEBOT_UA } }));
  assert.ok(isPassthroughResult(result));
  assert.deepEqual(calls, []);
});

test("a human on a NORG surface still runs the real sequence", async () => {
  // The agentic subtree, discovery artifacts and siblings are answered by URL
  // for every caller, so a human there is not on the fast path.
  for (const uri of ["/ai/widgets/", "/llms.txt", "/about/index.md", "/.well-known/mcp.json"]) {
    __test_setFeed(null);
    const { calls } = stubNetwork({ mirror: () => mirrorHit(), origin: () => new Response("", { status: 404 }) });
    await handler(cloudFrontEvent({ uri, headers: { "user-agent": CHROME_UA } }));
    assert.ok(calls.some((c) => c.url.includes("bot-patterns")), `${uri}: the feed decides entitlement here`);
  }
});

test("anything that might be an agent leaves the fast path", async () => {
  const shapes = [
    { name: "bot-shaped user agent", headers: { "user-agent": GPTBOT_UA } },
    { name: "no user agent", headers: {} },
    { name: "a Web Bot Auth signature on a Chrome UA", headers: { "user-agent": CHROME_UA, "signature-agent": '"https://chatgpt.com"' } },
    { name: "the ?agent=true override", headers: { "user-agent": CHROME_UA }, querystring: "agent=true" },
  ];
  for (const { name, headers, querystring = "" } of shapes) {
    __test_setFeed(null);
    const { calls } = stubNetwork({ mirror: () => mirrorHit() });
    await handler(cloudFrontEvent({ headers, querystring }));
    assert.ok(calls.some((c) => c.url.includes("bot-patterns")), `${name}: must reach the feed`);
  }
});

test("a verbose human passthrough event is fired but never awaited", async () => {
  let resolveEvent;
  const settled = new Promise((resolve) => {
    resolveEvent = resolve;
  });
  const { calls } = stubNetwork({
    control: async () => {
      await settled;
      return new Response("{}", { status: 200 });
    },
  });

  const result = await handler(
    cloudFrontEvent({ headers: { "user-agent": CHROME_UA }, config: { "x-norg-events-verbose": "true" } }),
  );

  assert.ok(isPassthroughResult(result), "the handler returned while the event was still in flight");
  assert.equal(calls.filter((c) => c.url.includes("/api/v1/edge/events")).length, 1);
  resolveEvent();
});

test("the browser test is deliberately lopsided", () => {
  assert.equal(isOrdinaryBrowser(CHROME_UA), true);
  assert.equal(isOrdinaryBrowser("Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/128.0"), true);
  for (const ua of [
    "",
    GPTBOT_UA,
    "curl/8.4.0",
    "Mozilla/5.0 (compatible; MSIE 10.0; Trident/6.0)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
    "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
  ]) {
    assert.equal(isOrdinaryBrowser(ua), false, ua || "(empty)");
  }
});

test("a verified agent is still served, with no header a human would see", async () => {
  stubNetwork({ mirror: () => mirrorHit("<html><body>NORG render</body></html>") });
  const result = await handler(cloudFrontEvent({ headers: { "user-agent": GPTBOT_UA } }));
  assert.equal(header(result, "x-norg-edge"), "mirror");
});
