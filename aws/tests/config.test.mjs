/**
 * Install-config reading and, above all, redaction.
 *
 * @description Proves the site key never survives into the origin request.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  binding,
  contentStem,
  controlHeaders,
  edgeEnv,
  isConfigured,
  readConfig,
} from "../lambda/lib/config.js";

/**
 * Build a CloudFront request carrying the given custom origin headers.
 *
 * @param {Object} headers Plain {header: value} map.
 * @returns {Object} CloudFront request object.
 */
function requestWithCustomHeaders(headers) {
  const customHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    customHeaders[key] = [{ key, value }];
  }
  return { uri: "/", headers: {}, origin: { custom: { domainName: "example.com", customHeaders } } };
}

test("reads every binding from custom origin headers", () => {
  const request = requestWithCustomHeaders({
    "x-norg-site-id": "site-1",
    "x-norg-site-key": "nek_live_secret",
    "x-norg-api-url": "https://api.test.norg.ai",
    "x-norg-content-base": "https://edge-content.test.norg.ai",
    "x-norg-strip-fallback": "false",
    "x-norg-disabled": "true",
    "x-norg-lazy-render": "false",
    "x-norg-env": "test",
    "x-norg-events-verbose": "true",
  });

  assert.deepEqual(readConfig(request), {
    SITE_ID: "site-1",
    NORG_SITE_KEY: "nek_live_secret",
    NORG_API_URL: "https://api.test.norg.ai",
    NORG_CONTENT_BASE: "https://edge-content.test.norg.ai",
    STRIP_FALLBACK_ENABLED: "false",
    EDGE_DISABLED: "true",
    LAZY_RENDER_ENABLED: "false",
    EDGE_ENV: "test",
    EDGE_EVENTS_VERBOSE: "true",
  });
});

test("deletes NORG config headers so they never reach the customer origin", () => {
  const request = requestWithCustomHeaders({
    "x-norg-site-id": "site-1",
    "x-norg-site-key": "nek_live_secret",
    "x-custom-unrelated": "keep-me",
  });

  readConfig(request);
  const remaining = request.origin.custom.customHeaders;

  assert.deepEqual(Object.keys(remaining), ["x-custom-unrelated"]);
  assert.equal(
    JSON.stringify(remaining).includes("nek_live_secret"),
    false,
    "the site key must not survive anywhere in the origin request",
  );
});

test("deletes config headers even when unset, and leaves the customer's own alone", () => {
  const request = requestWithCustomHeaders({ "x-norg-env": "production", "x-api-key": "theirs" });
  readConfig(request);
  assert.deepEqual(Object.keys(request.origin.custom.customHeaders), ["x-api-key"]);
});

test("survives an origin with no custom headers at all", () => {
  assert.deepEqual(readConfig({ uri: "/", origin: { custom: { domainName: "e.com" } } }), {});
  assert.deepEqual(readConfig({ uri: "/" }), {});
});

test("absent bindings take the baked default, set ones override it", () => {
  assert.equal(binding({}, "NORG_API_URL"), "https://content-craft-api.norg.ai");
  assert.equal(binding({}, "STRIP_FALLBACK_ENABLED"), "true");
  assert.equal(binding({ STRIP_FALLBACK_ENABLED: "false" }, "STRIP_FALLBACK_ENABLED"), "false");
  // An explicit empty string is a real value, not an absent binding.
  assert.equal(binding({ NORG_API_URL: "" }, "NORG_API_URL"), "");
});

test("EDGE_ENV has no default and falls back to unknown", () => {
  assert.equal(edgeEnv({}), "unknown");
  assert.equal(edgeEnv({ EDGE_ENV: "test" }), "test");
});

test("contentStem joins the content base to the site id without a double slash", () => {
  assert.equal(
    contentStem({ SITE_ID: "site-1", NORG_CONTENT_BASE: "https://edge-content.norg.ai/" }),
    "https://edge-content.norg.ai/site-1",
  );
  assert.equal(contentStem({ SITE_ID: "site-1" }), "https://edge-content.norg.ai/site-1");
});

test("control headers carry both credentials and the script version", () => {
  const headers = controlHeaders({ SITE_ID: "site-1", NORG_SITE_KEY: "k" });
  assert.equal(headers["X-Norg-Site-Id"], "site-1");
  assert.equal(headers["X-Norg-Site-Key"], "k");
  assert.match(headers["X-Norg-Edge-Version"], /^\d+\.\d+\.\d+$/);
});

test("an install missing either credential is not configured", () => {
  assert.equal(isConfigured({ SITE_ID: "s", NORG_SITE_KEY: "k" }), true);
  assert.equal(isConfigured({ SITE_ID: "s" }), false);
  assert.equal(isConfigured({ NORG_SITE_KEY: "k" }), false);
  assert.equal(isConfigured({}), false);
});
