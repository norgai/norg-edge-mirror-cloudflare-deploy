/**
 * The Vercel adapters: config, client identity, and the Next.js wrapper.
 *
 * @description Unit tests for everything the pipeline suite takes as given.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { __test_setFeed } from "../../core/feed.js";
import { EDGE_SCRIPT_VERSION, readConfig } from "../src/lib/config.js";
import { clientIp, edgeRegion, visitView } from "../src/lib/request.js";
import { norgEdgeMiddleware, withNorgEdge } from "../src/next.js";
import { CHROME_UA, OPTIONS, html, stubNetwork, vercelRequest, waitUntilContext } from "./helpers.mjs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
});

test("config maps NORG_* variables onto core's binding names", () => {
  const env = readConfig({}, {
    NORG_SITE_ID: " site-9 ",
    NORG_SITE_KEY: "nek_live_x",
    NORG_EDGE_DISABLED: "true",
    NORG_LAZY_RENDER_ENABLED: "false",
  });
  assert.equal(env.SITE_ID, "site-9");
  assert.equal(env.NORG_SITE_KEY, "nek_live_x");
  assert.equal(env.EDGE_DISABLED, "true");
  assert.equal(env.LAZY_RENDER_ENABLED, "false");
  assert.equal(env.EDGE_PLATFORM, "vercel");
  assert.equal(env.EDGE_SCRIPT_VERSION, EDGE_SCRIPT_VERSION);
});

test("options win over the environment, and blank is absent", () => {
  const env = readConfig({ siteId: "from-option", apiUrl: "" }, { NORG_SITE_ID: "from-env", NORG_API_URL: "  " });
  assert.equal(env.SITE_ID, "from-option");
  assert.equal("NORG_API_URL" in env, false);
});

test("the NORG environment is derived from the API host", () => {
  assert.equal(readConfig({}, {}).EDGE_ENV, "production");
  assert.equal(readConfig({ apiUrl: "https://content-craft-api.norg.ai/" }, {}).EDGE_ENV, "production");
  assert.equal(readConfig({ apiUrl: "https://content-craft-test1-api.norg.ai" }, {}).EDGE_ENV, "test");
  assert.equal(readConfig({ apiUrl: "https://elsewhere.example" }, {}).EDGE_ENV, "unknown");
  assert.equal(readConfig({ env: "test" }, {}).EDGE_ENV, "test");
});

test("client IP: Vercel's header only when trusted, last hop of a list", () => {
  const request = vercelRequest({ headers: { "x-real-ip": "", "x-forwarded-for": "1.1.1.1, 20.171.5.9" } });
  assert.equal(clientIp(request, { trustVercelHeaders: true }), "20.171.5.9");
  assert.equal(clientIp(request, { trustVercelHeaders: false }), "");
  assert.equal(clientIp(request, { getClientIp: () => " 9.9.9.9 " }), "9.9.9.9");
});

test("edge region and geo come from Vercel's headers", () => {
  const request = vercelRequest();
  assert.equal(edgeRegion(request), "syd1");
  assert.equal(edgeRegion(vercelRequest({ headers: { "x-vercel-id": "nonsense" } })), null);
  const view = visitView(request);
  assert.equal(view.headers.get("cloudfront-viewer-country"), "AU");
  assert.equal(view.headers.get("cloudfront-viewer-city"), "São Paulo");
});

test("withNorgEdge: the app's middleware runs when NORG has nothing to serve", async () => {
  stubNetwork();
  const seen = [];
  const appMiddleware = (request, event) => {
    seen.push([new URL(request.url).pathname, typeof event.waitUntil]);
    return new Response("app");
  };
  const result = await withNorgEdge(appMiddleware, OPTIONS)(
    vercelRequest({ userAgent: CHROME_UA }),
    waitUntilContext(),
  );
  assert.equal(await result.text(), "app");
  assert.deepEqual(seen, [["/widgets/", "function"]]);
});

test("withNorgEdge: the app's middleware is skipped when NORG answers", async () => {
  stubNetwork({ mirror: () => html("<html>m</html>") });
  let called = false;
  const result = await withNorgEdge(() => {
    called = true;
  }, OPTIONS)(vercelRequest(), waitUntilContext());
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
  assert.equal(called, false);
});

test("norgEdgeMiddleware with no app middleware continues with undefined", async () => {
  stubNetwork();
  const result = await norgEdgeMiddleware(OPTIONS)(vercelRequest({ userAgent: CHROME_UA }));
  assert.equal(result, undefined);
});

test("a pipeline that fails after the watchdog fired is never an unhandled rejection", async () => {
  const { __test_raceWatchdog: race } = await import("../src/index.js");
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 30));
    const result = await race(late, 5);
    assert.equal(result, null, "the watchdog answers with the site");
    // Let the late rejection land, then one more tick for any unhandled report.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
