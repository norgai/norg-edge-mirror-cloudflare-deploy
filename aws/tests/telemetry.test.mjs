/**
 * The passthrough event: the one control call the routers still make.
 *
 * @description Pins that it is opt-in, off the visitor's path, and keep-alive aware.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { fireEdgeEvent, reportPassthrough } from "../../core/telemetry.js";

const ENV = { SITE_ID: "site-1", NORG_SITE_KEY: "k", EDGE_SCRIPT_VERSION: "0.6.0", EDGE_PLATFORM: "cloudfront" };
const HUMAN = { is_ai_bot: false, bot_name: null, company: null, purpose: null };

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
    return new Response("{}", { status: 200 });
  };
}

const requestWith = (headers = {}) => new Request("https://shop.example.com/widgets/", { headers });

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a passthrough event is not sent unless the install opts in", async () => {
  captureFetch();
  reportPassthrough(ENV, requestWith(), HUMAN);
  await fireEdgeEvent(ENV, requestWith(), HUMAN, "origin");
  assert.equal(posts.length, 0, "human traffic must not carry a NORG round trip by default");
});

test("an opted-in passthrough event carries the domain, path and viewer geo", async () => {
  captureFetch();
  await fireEdgeEvent(
    { ...ENV, EDGE_EVENTS_VERBOSE: "true" },
    requestWith({
      "user-agent": "Mozilla/5.0 Chrome/125.0",
      "cloudfront-viewer-country": "AU",
      "cloudfront-viewer-tls": "TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake",
    }),
    HUMAN,
    "origin",
  );
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/v1\/edge\/events$/);
  assert.equal(posts[0].headers["X-Norg-Site-Key"], "k");
  assert.deepEqual(posts[0].body, {
    domain: "shop.example.com",
    path: "/widgets/",
    user_agent: "Mozilla/5.0 Chrome/125.0",
    is_ai_bot: false,
    bot_name: null,
    company: null,
    purpose: null,
    served: "origin",
    raw_word_count: null,
    response_status: null,
    ip_country: "AU",
    ip_city: null,
    asn: null,
    as_organization: null,
    colo: null,
    http_protocol: null,
    tls_version: "TLSv1.3",
  });
});

test("reportPassthrough hands the call to the platform keep-alive when there is one", async () => {
  captureFetch();
  const held = [];
  reportPassthrough({ ...ENV, EDGE_EVENTS_VERBOSE: "true", EDGE_KEEPALIVE: (p) => held.push(p) }, requestWith(), HUMAN);
  assert.equal(held.length, 1, "Fastly and Bunny hold the instance open for it");
  await Promise.all(held);
  assert.equal(posts.length, 1);
});

test("reportPassthrough starts the call at once when there is no keep-alive", async () => {
  captureFetch();
  reportPassthrough({ ...ENV, EDGE_EVENTS_VERBOSE: "true" }, requestWith(), HUMAN);
  assert.equal(posts.length, 1, "started synchronously; nothing waits for it");
});

test("a failing call never escapes to the caller", async () => {
  globalThis.fetch = async () => {
    throw new Error("NORG unreachable");
  };
  await fireEdgeEvent({ ...ENV, EDGE_EVENTS_VERBOSE: "true" }, requestWith(), HUMAN, "origin");
  reportPassthrough({ ...ENV, EDGE_EVENTS_VERBOSE: "true" }, requestWith(), HUMAN);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(true);
});
