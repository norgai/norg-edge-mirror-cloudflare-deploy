/**
 * The three Bunny adapters: config, request identity, and the origin sentinel.
 *
 * @description Guards the platform-specific half of the port.
 *
 * These are the only files that could not be shared with the other providers,
 * so they are the only place a Bunny-shaped mistake can hide.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EDGE_SCRIPT_VERSION, readConfig } from "../src/lib/config.js";
import { PASSTHROUGH, fetchOrigin } from "../src/lib/origin.js";
import { clientIp, visitorHost, visitorUrl } from "../src/lib/request.js";
import { htmlNoCacheRule, norgNoStoreRule } from "../install.mjs";
import { binding, isConfigured } from "../../core/config.js";
import { bunnyRequest, ORIGIN_HOST, PUBLIC_HOST, UNVERIFIED_IP, VERIFIED_IP } from "./helpers.mjs";

// --- config ----------------------------------------------------------------

test("readConfig produces the binding shape core/ expects", () => {
  const env = readConfig({
    SITE_ID: "s1",
    NORG_SITE_KEY: "nek_live_x",
    NORG_API_URL: "https://api.example.com",
    EDGE_ENV: "test",
  });
  assert.equal(env.SITE_ID, "s1");
  assert.equal(env.EDGE_PLATFORM, "bunny");
  assert.equal(env.EDGE_SCRIPT_VERSION, EDGE_SCRIPT_VERSION);
  assert.ok(isConfigured(env));
});

test("a blank Bunny variable falls back to the baked default", () => {
  // Bunny declares variables up front, so an optional one left unset arrives
  // as "" rather than undefined. Passing "" through would send every control
  // call to a relative URL.
  const env = readConfig({ SITE_ID: "s1", NORG_SITE_KEY: "k", NORG_API_URL: "   " });
  assert.equal(binding(env, "NORG_API_URL"), "https://content-craft-api.norg.ai");
});

test("an unconfigured install is inert rather than throwing", () => {
  assert.equal(isConfigured(readConfig({})), false);
  assert.equal(isConfigured(readConfig(undefined)), false);
  assert.equal(isConfigured(readConfig({ SITE_ID: "s1" })), false, "the key is compulsory too");
});

test("readConfig reads nothing it was not asked for", () => {
  const env = readConfig({ SITE_ID: "s1", NORG_SITE_KEY: "k", SOME_OTHER_SECRET: "leak" });
  assert.equal(Object.values(env).includes("leak"), false);
});

// --- request identity ------------------------------------------------------

test("the client IP comes from the header Bunny sets, not the caller's", () => {
  const request = bunnyRequest({ clientIp: VERIFIED_IP });
  assert.equal(clientIp(request), VERIFIED_IP);
});

test("a comma-separated x-forwarded-for reads from the END", () => {
  // Bunny replaces the header today. If it ever appends instead, the
  // edge-observed address is the last entry and a caller-supplied one is first.
  const request = new Request("https://origin.example.com/", {
    headers: { "x-forwarded-for": `${UNVERIFIED_IP}, ${VERIFIED_IP}` },
  });
  assert.equal(clientIp(request), VERIFIED_IP);
});

test("no published address reads as empty, so gate 3 fails closed", () => {
  const request = new Request("https://origin.example.com/");
  assert.equal(clientIp(request), "");
});

test("the visitor host survives Bunny's rewrite to the origin", () => {
  const request = bunnyRequest({ path: "/widgets/?agent=true" });
  assert.equal(request.url, `https://${ORIGIN_HOST}/widgets/?agent=true`);
  assert.equal(visitorHost(request), PUBLIC_HOST);

  const url = visitorUrl(request);
  assert.equal(url.hostname, PUBLIC_HOST);
  assert.equal(url.pathname, "/widgets/");
  assert.equal(url.searchParams.get("agent"), "true");
});

test("visitorUrl falls back to the Host header, then to the origin URL", () => {
  const hostOnly = new Request("https://origin.example.com/a", {
    headers: { host: "shop.example.com" },
  });
  assert.equal(visitorUrl(hostOnly).hostname, "shop.example.com");

  const neither = new Request("https://origin.example.com/a");
  assert.equal(visitorUrl(neither).hostname, "origin.example.com");
});

// --- origin ----------------------------------------------------------------

test("the passthrough sentinel is a unique frozen object", () => {
  assert.equal(Object.isFrozen(PASSTHROUGH), true);
  assert.notEqual(PASSTHROUGH, Object.freeze({ norgEdge: "passthrough" }));
});

test("fetchOrigin adds the loop guard and never throws", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    seen.push(input.headers.get("x-norg-edge"));
    return new Response("ok", { status: 200 });
  };
  try {
    const response = await fetchOrigin(bunnyRequest(), 1000);
    assert.equal(response.status, 200);
    assert.equal(seen[0], "1");

    globalThis.fetch = async () => {
      throw new Error("origin unreachable");
    };
    assert.equal(await fetchOrigin(bunnyRequest(), 1000), null, "an unreachable origin is null");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- installer: the two edge rules --------------------------------------------

test("the HTML-only rule keeps pages out of the cache and touches nothing else", () => {
  // Importing install.mjs must make no network call; the rule builders are
  // pure. One trigger, one pattern: Bunny refuses more than five per trigger,
  // and an asset denylist needs about fifty.
  const rule = htmlNoCacheRule();
  assert.equal(rule.ActionType, "OverrideCacheTime");
  assert.equal(rule.ActionParameter1, "0");
  assert.equal(rule.Enabled, true);
  assert.equal(rule.Triggers.length, 1);
  assert.deepEqual(rule.Triggers[0], {
    Type: "ResponseHeader",
    PatternMatches: ["*text/html*"],
    PatternMatchingType: 0,
    Parameter1: "Content-Type",
  });
});

test("the NORG no-store rule matches only responses the router stamped", () => {
  const rule = norgNoStoreRule();
  assert.equal(rule.ActionType, "OverrideBrowserCacheResponseHeader");
  assert.equal(rule.ActionParameter1, "private, no-store");
  assert.equal(rule.Triggers[0].Parameter1, "X-Norg-Edge");
});
