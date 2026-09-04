/**
 * The CloudFront request pipeline, end to end through the Lambda handler.
 *
 * @description Proves the router makes the Cloudflare worker's decisions.
 *
 * The first test in this file is the one that matters most: a real browser
 * user-agent must come back untouched, with no NORG header of any kind. That
 * is the invariant scripts/edge/human_probe.py guards in production — a human
 * receiving the agent variant turns a bug in this file into an incident on the
 * customer's revenue pages.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { handler } from "../lambda/edge-router-lambda.js";
import { __test_setFeed } from "../lambda/lib/feed.js";
import { __test_reset as resetDeferred } from "../lambda/lib/deferred.js";
import { __test_reset as resetTelemetry } from "../lambda/lib/telemetry.js";
import {
  CHROME_UA,
  GOOGLEBOT_UA,
  GPTBOT_UA,
  SITE_KEY,
  UNVERIFIED_IP,
  cloudFrontEvent,
  header,
  isPassthroughResult,
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
 * Run the handler against a fresh, entitled container.
 *
 * @param {Object} eventOptions Options for cloudFrontEvent.
 * @param {Object} network Options for stubNetwork.
 * @returns {Promise<{result: Object, calls: Array, event: Object}>} Outcome.
 */
async function run(eventOptions = {}, network = {}) {
  const { calls } = stubNetwork(network);
  const event = cloudFrontEvent(eventOptions);
  const result = await handler(event);
  return { result, calls, event };
}

// --- Rule 1 and rule 2: humans and search engines are never touched ---------

test("a real browser gets the origin, with no NORG header at all", async () => {
  const { result } = await run({ headers: { "user-agent": CHROME_UA } }, { mirror: () => mirrorHit() });

  assert.ok(isPassthroughResult(result), "a human must never get a generated response");
  const serialised = JSON.stringify(result);
  assert.equal(/x-norg-edge/i.test(serialised), false, "no NORG header may reach a human");
});

test("Googlebot always gets the origin, even with ?agent=true", async () => {
  for (const querystring of ["", "agent=true"]) {
    const { result } = await run(
      { headers: { "user-agent": GOOGLEBOT_UA }, querystring },
      { mirror: () => mirrorHit() },
    );
    assert.ok(isPassthroughResult(result), `search-bot floor breached with "${querystring}"`);
  }
});

test("the search-bot floor holds even when the mirror exists and the UA is a bot", async () => {
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

// --- Rule 3: nothing happens without an authenticated feed ------------------

test("an unentitled install passes everything through untouched", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { feed: () => new Response("denied", { status: 403 }), mirror: () => mirrorHit() },
  );

  assert.ok(isPassthroughResult(result));
  assert.equal(
    calls.some((c) => c.url.includes("edge-content")),
    false,
    "no mirror lookup may happen without entitlement",
  );
});

test("an unentitled install does not serve NORG-owned surfaces either", async () => {
  // These surfaces are matched by PATH, not by classification, so an empty
  // pattern list does not protect them — only the entitlement gate does.
  for (const uri of ["/llms.txt", "/.norg/theme.css", "/openapi.json", "/.well-known/mcp.json"]) {
    const { result, calls } = await run(
      { uri, headers: { "user-agent": CHROME_UA } },
      {
        feed: () => new Response("denied", { status: 403 }),
        mirror: () => mirrorHit("norg copy"),
        origin: () => new Response("", { status: 404 }),
      },
    );

    assert.ok(isPassthroughResult(result), `${uri} was served without entitlement`);
    assert.equal(
      calls.some((c) => c.url.includes("edge-content")),
      false,
      `${uri} hit the receptionist without entitlement`,
    );
  }
});

test("an unentitled install ignores the ?agent=true override", async () => {
  // The override runs before classification, so an empty pattern list does not
  // stop it either.
  const { result } = await run(
    { querystring: "agent=true", headers: { "user-agent": CHROME_UA } },
    { feed: () => new Response("denied", { status: 403 }), mirror: () => mirrorHit() },
  );
  assert.ok(isPassthroughResult(result));
});

test("an install missing its credentials makes no NORG call whatsoever", async () => {
  const { result, calls } = await run({
    headers: { "user-agent": GPTBOT_UA },
    config: { "x-norg-site-key": undefined },
  });

  assert.ok(isPassthroughResult(result));
  assert.deepEqual(calls, [], "an unconfigured install must be completely inert");
});

// --- The divert path -------------------------------------------------------

test("a verified AI agent with a rendered page gets the mirror", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit("<html><body>NORG render</body></html>") },
  );

  assert.equal(header(result, "x-norg-edge"), "mirror");
  assert.equal(header(result, "cache-control"), "private, no-store");
  assert.equal(header(result, "cdn-cache-control"), "private, no-store");
  assert.equal(header(result, "x-norg-edge-env"), "test");
  assert.match(result.body, /NORG render/);
});

test("a diverted response is never storable by any cache", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  // Vary: User-Agent is deliberately NOT used — CDNs mishandle it, which is
  // the exact failure no-store replaces.
  assert.equal(header(result, "vary"), null);
});

test("a spoofed user-agent from an unverified IP is not diverted", async () => {
  const { result, calls } = await run(
    { headers: { "user-agent": GPTBOT_UA }, clientIp: UNVERIFIED_IP },
    { mirror: () => mirrorHit() },
  );

  assert.ok(isPassthroughResult(result), "curl -A GPTBot must not harvest the mirror");
  assert.equal(calls.some((c) => c.url.includes("edge-content")), false);
});

test("a crawler NORG has not authorised to divert is passed through", async () => {
  const { result } = await run(
    { headers: { "user-agent": "Mozilla/5.0 (compatible; CCBot/2.0)" } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthroughResult(result), "serving_policy never_divert must be obeyed");
});

test("serving_policy is obeyed even when the source IP WOULD verify", async () => {
  // HeldBot's operator publishes the same range the request comes from, so the
  // source-IP gate would pass it. Only the serving-policy gate stops it, which
  // is what makes this test able to see that gate at all.
  const { result, calls } = await run(
    { headers: { "user-agent": "Mozilla/5.0 (compatible; HeldBot/1.0)" } },
    { mirror: () => mirrorHit() },
  );

  assert.ok(
    isPassthroughResult(result),
    "an operator must be able to withdraw a crawler with one column",
  );
  assert.equal(calls.some((c) => c.url.includes("edge-content")), false);
});

// --- Misses, strip and lazy render -----------------------------------------

test("a mirror miss strips the origin and asks NORG to render", async () => {
  const { result, calls } = await run({ headers: { "user-agent": GPTBOT_UA } });

  assert.equal(header(result, "x-norg-edge"), "stripped");
  assert.equal(/<nav>|<script/i.test(result.body), false, "the strip did not run");
  assert.match(result.body, /word0/);
  assert.ok(
    calls.some((c) => c.url.includes("/api/v1/edge/render-requests")),
    "a definite 404 must enqueue a render",
  );
});

test("a thin strip serves the untouched origin instead", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    {
      origin: () =>
        new Response("<html><body><nav>menu</nav><p>Only a few words here.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    },
  );

  assert.ok(
    isPassthroughResult(result),
    "below STRIP_WORD_FLOOR the real page beats a page with its content removed",
  );
});

test("LAZY_RENDER_ENABLED=false serves the strip without asking for a render", async () => {
  const { result, calls } = await run({
    headers: { "user-agent": GPTBOT_UA },
    config: { "x-norg-lazy-render": "false" },
  });

  assert.equal(header(result, "x-norg-edge"), "stripped");
  assert.equal(
    calls.some((c) => c.url.includes("/render-requests")),
    false,
    "a deployed-only edge must not trigger renders",
  );
});

test("STRIP_FALLBACK_ENABLED=false passes the origin through on a miss", async () => {
  const { result } = await run({
    headers: { "user-agent": GPTBOT_UA },
    config: { "x-norg-strip-fallback": "false" },
  });
  assert.ok(isPassthroughResult(result));
});

test("a non-HTML origin is never stripped", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    {
      origin: () =>
        new Response('{"data":1}', { status: 200, headers: { "content-type": "application/json" } }),
    },
  );
  assert.notEqual(header(result, "x-norg-edge"), "stripped");
});

// --- The 1 MB generated-response ceiling -----------------------------------

test("a mirror too large to inline is served by repointing the origin at NORG", async () => {
  const big = "x".repeat(900 * 1024);
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit(big) },
  );

  assert.ok(isPassthroughResult(result), "an oversized body must not be a generated response");
  assert.equal(result.origin.custom.domainName, "edge-content.test.norg.ai");
  assert.equal(result.uri, "/site-1/widgets/index.html", "the mirror key becomes the origin path");
  assert.equal(result.headers.host[0].value, "edge-content.test.norg.ai");
  assert.equal(
    result.origin.custom.customHeaders["x-norg-site-key"][0].value,
    SITE_KEY,
    "the receptionist read must stay authenticated",
  );
});

test("a mirror with no declared length is treated as large rather than risking a 502", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    {
      // A streamed body has no content-length, which is the case that matters:
      // guessing "small" and being wrong is a 502.
      mirror: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<html>stream</html>"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    },
  );
  assert.ok(isPassthroughResult(result));
  assert.equal(result.origin.custom.domainName, "edge-content.test.norg.ai");
});

// --- Surfaces served to every caller ---------------------------------------

test("a reserved /.norg/ asset is public and served to anyone", async () => {
  const { result } = await run(
    { uri: "/.norg/theme.css", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit("body{}", { "content-type": "text/css" }) },
  );

  assert.equal(header(result, "x-norg-edge"), "reserved-asset");
  assert.match(header(result, "cache-control"), /^public,/);
});

test("an OpenAI feed artifact is served to anyone", async () => {
  const { result } = await run(
    { uri: "/openapi.json", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit('{"openapi":"3.1.0"}', { "content-type": "application/json" }) },
  );
  assert.equal(header(result, "x-norg-edge"), "openai-feed");
});

test("the agentic subtree is served by URL to a plain browser", async () => {
  const { result } = await run(
    { uri: "/ai/widgets/", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(header(result, "x-norg-edge"), "mirror");
});

test("/ai does not capture a path that merely starts with it", async () => {
  const { result } = await run(
    { uri: "/aircraft/", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthroughResult(result), "/aircraft is a customer page, not the agentic subtree");
});

test("a discovery artifact prefers the customer's own file", async () => {
  const { result } = await run(
    { uri: "/llms.txt", headers: { "user-agent": CHROME_UA } },
    {
      origin: () =>
        new Response("customer llms", { status: 200, headers: { "content-type": "text/plain" } }),
      mirror: () => mirrorHit("norg llms"),
    },
  );
  assert.match(result.body, /customer llms/);
});

test("an HTML 200 for a discovery artifact is a soft-404 and loses to NORG's copy", async () => {
  const { result } = await run(
    { uri: "/llms.txt", headers: { "user-agent": CHROME_UA } },
    {
      origin: () =>
        new Response("<html>404</html>", { status: 200, headers: { "content-type": "text/html" } }),
      mirror: () => mirrorHit("norg llms", { "content-type": "text/plain" }),
    },
  );
  assert.match(result.body, /norg llms/);
});

// --- Floors and operator controls ------------------------------------------

test("a static subresource skips the whole pipeline", async () => {
  const { result, calls } = await run(
    { uri: "/assets/app.css", headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );

  assert.ok(isPassthroughResult(result));
  assert.equal(calls.some((c) => c.url.includes("edge-content")), false);
});

test("an operator-skipped path is served from the origin even to a verified agent", async () => {
  const { result } = await run(
    { uri: "/checkout", headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(isPassthroughResult(result));
});

test("a sibling artifact of a skipped page is skipped too", async () => {
  const { result } = await run(
    { uri: "/checkout/index.md", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.ok(
    isPassthroughResult(result),
    "excluding /checkout must also exclude the sibling carrying the same text",
  );
});

// --- Passthrough conditions ------------------------------------------------

test("EDGE_DISABLED is a remote off switch", async () => {
  const { result, calls } = await run({
    headers: { "user-agent": GPTBOT_UA },
    config: { "x-norg-disabled": "true" },
  });

  assert.ok(isPassthroughResult(result));
  assert.deepEqual(calls, [], "a disabled install must not even fetch the feed");
});

test("our own loop-guarded subrequest is never reprocessed", async () => {
  const { result } = await run({
    headers: { "user-agent": GPTBOT_UA, "x-norg-edge": "1" },
  });
  assert.ok(isPassthroughResult(result));
});

test("a websocket upgrade is passed straight through", async () => {
  const { result } = await run({
    headers: { "user-agent": GPTBOT_UA, upgrade: "websocket" },
  });
  assert.ok(isPassthroughResult(result));
});

test("a non-GET method belongs to the customer's application", async () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const { result } = await run({ method, headers: { "user-agent": GPTBOT_UA } });
    assert.ok(isPassthroughResult(result), `${method} must pass through`);
  }
});

test("a POST is passed through unless it is the MCP transport", async () => {
  const plain = await run({ method: "POST", uri: "/cart/add" });
  assert.ok(isPassthroughResult(plain.result));

  const mcp = await run(
    { method: "POST", uri: "/mcp" },
    { control: () => new Response('{"jsonrpc":"2.0"}', { status: 200 }) },
  );
  assert.equal(mcp.result.status, "200");
});

test("HEAD is answered for a NORG-owned path but passed through for a customer page", async () => {
  const owned = await run(
    { method: "HEAD", uri: "/llms.txt", headers: { "user-agent": CHROME_UA } },
    {
      origin: () => new Response("", { status: 404 }),
      mirror: () => mirrorHit("norg llms", { "content-type": "text/plain" }),
    },
  );
  assert.equal(owned.result.status, "200", "HEAD must report what GET would");

  const page = await run({ method: "HEAD", uri: "/widgets/", headers: { "user-agent": CHROME_UA } });
  assert.ok(isPassthroughResult(page.result));
});

// --- Health probe and the ?agent=true override -----------------------------

test("an authenticated health probe reports the install's state", async () => {
  const { result } = await run({ headers: { "x-norg-edge-check": SITE_KEY } });
  const body = JSON.parse(result.body);

  assert.equal(body.site_id, "site-1");
  assert.equal(body.env, "test");
  assert.equal(body.platform, "cloudfront");
  assert.equal(body.disabled, false);
  assert.equal(typeof body.entitled, "boolean");
});

test("a wrong probe key never shadows a real customer URL", async () => {
  const { result } = await run({ headers: { "x-norg-edge-check": "wrong", "user-agent": CHROME_UA } });
  assert.ok(isPassthroughResult(result));
});

test("?agent=true forces the mirror for a browser but enqueues no render", async () => {
  const hit = await run(
    { querystring: "agent=true", headers: { "user-agent": CHROME_UA } },
    { mirror: () => mirrorHit() },
  );
  assert.equal(header(hit.result, "x-norg-edge"), "mirror");

  const miss = await run({ querystring: "agent=true", headers: { "user-agent": CHROME_UA } });
  assert.ok(isPassthroughResult(miss.result));
  assert.equal(
    miss.calls.some((c) => c.url.includes("/render-requests")),
    false,
    "demo traffic must not trigger renders across the catalogue",
  );
});

// --- The Host header on passthrough ----------------------------------------

test("a passthrough asks the origin for the hostname the ORIGIN serves", async () => {
  // The origin request policy forwards the viewer's Host (that is the only
  // behaviour that also supplies the CloudFront-Viewer-* geo headers), so
  // without correction the origin would be asked for the CloudFront-facing
  // hostname and every human visitor would get a broken page.
  const { result } = await run({ headers: { "user-agent": CHROME_UA } });

  assert.ok(isPassthroughResult(result));
  assert.equal(result.headers.host[0].value, "origin.example.com");
});

test("every early passthrough aligns the Host too, not just the classified ones", async () => {
  for (const options of [
    { config: { "x-norg-disabled": "true" } },
    { headers: { "x-norg-edge": "1" } },
    { method: "PUT" },
    { uri: "/assets/app.css" },
    { uri: "/checkout", headers: { "user-agent": GPTBOT_UA } },
  ]) {
    const { result } = await run(options);
    assert.ok(isPassthroughResult(result));
    assert.equal(
      result.headers.host[0].value,
      "origin.example.com",
      `Host not aligned for ${JSON.stringify(options)}`,
    );
  }
});

test("an origin switch keeps the receptionist's Host, not the customer origin's", async () => {
  const big = "x".repeat(900 * 1024);
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    { mirror: () => mirrorHit(big) },
  );

  assert.equal(result.headers.host[0].value, "edge-content.test.norg.ai");
});

// --- Rule 1 under failure --------------------------------------------------

test("a NORG outage degrades to the origin, never to an error", async () => {
  const { result } = await run(
    { headers: { "user-agent": GPTBOT_UA } },
    {
      feed: () => {
        throw new Error("ECONNRESET");
      },
    },
  );
  assert.ok(isPassthroughResult(result));
});

test("a throwing network layer still ends at the origin", async () => {
  globalThis.fetch = () => {
    throw new Error("catastrophic");
  };
  const result = await handler(cloudFrontEvent({ headers: { "user-agent": GPTBOT_UA } }));

  assert.ok(isPassthroughResult(result), "a throw here would be a 502 on the customer's site");
  assert.equal(result.uri, "/widgets/");
});

test("an unexpected exception is caught and the pristine request returned", async () => {
  // A malformed event throws inside the adapter, outside every inner
  // try/catch — the case the handler's own catch exists for. Anything escaping
  // here is a 502 on the customer's site, not a degraded response.
  stubNetwork({});
  const event = cloudFrontEvent({ headers: { "user-agent": GPTBOT_UA } });
  // Throws the moment anything reads the request, which is the case the
  // handler's own catch exists for. An exception escaping here is a 502 on the
  // customer's site, not a degraded response.
  Object.defineProperty(event.Records[0].cf.request, "uri", {
    get() {
      throw new Error("catastrophic");
    },
  });

  const result = await handler(event);

  assert.ok(isPassthroughResult(result), "the handler must never throw");
});

test("the site key never survives into the origin request", async () => {
  for (const options of [
    { headers: { "user-agent": CHROME_UA } },
    { headers: { "user-agent": GPTBOT_UA } },
    { uri: "/assets/app.css" },
    { config: { "x-norg-disabled": "true" } },
  ]) {
    const { result } = await run(options, { mirror: () => mirrorHit() });
    assert.equal(
      JSON.stringify(result).includes(SITE_KEY),
      false,
      `the site key leaked for ${JSON.stringify(options)}`,
    );
  }
});
