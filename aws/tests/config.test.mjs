/**
 * Install-config reading and, above all, redaction.
 *
 * @description Proves the site key never survives into the origin request.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readConfig } from "../lambda/lib/config.js";
import {
  binding,
  contentStem,
  controlHeaders,
  edgeEnv,
  isConfigured,
} from "../../core/config.js";

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
    "x-norg-secret-arn": "arn:aws:secretsmanager:us-east-1:1:secret:k",
    "x-norg-probe-token": "nprobe_tok",
    "x-norg-api-url": "https://api.test.norg.ai",
    "x-norg-content-base": "https://edge-content.test.norg.ai",
    "x-norg-strip-fallback": "false",
    "x-norg-disabled": "true",
    "x-norg-lazy-render": "false",
    "x-norg-env": "test",
    "x-norg-events-verbose": "true",
  });

  const env = readConfig(request);
  // The adapter stamps its own identity onto the config object; core reads the
  // version and platform from there rather than importing a constant, so one
  // core serves every provider.
  assert.equal(env.EDGE_SCRIPT_VERSION, "0.5.0");
  assert.equal(env.EDGE_PLATFORM, "cloudfront");
  delete env.EDGE_SCRIPT_VERSION;
  delete env.EDGE_PLATFORM;

  assert.deepEqual(env, {
    SITE_ID: "site-1",
    NORG_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:1:secret:k",
    PROBE_TOKEN: "nprobe_tok",
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
    "x-norg-secret-arn": "arn:aws:secretsmanager:us-east-1:1:secret:k",
    "x-norg-probe-token": "nprobe_tok",
    "x-custom-unrelated": "keep-me",
  });

  readConfig(request);
  const remaining = request.origin.custom.customHeaders;

  assert.deepEqual(Object.keys(remaining), ["x-custom-unrelated"]);
  assert.equal(
    JSON.stringify(remaining).includes("nprobe_tok"),
    false,
    "the probe token must not survive anywhere in the origin request",
  );
});

test("strips the health-probe header from the request itself", () => {
  // Not a custom origin header — it arrives on the viewer request, and a
  // FAILING probe used to ride all the way through to the customer's origin
  // and into their access logs.
  const request = requestWithCustomHeaders({ "x-norg-site-id": "site-1" });
  request.headers["x-norg-edge-check"] = [{ key: "x-norg-edge-check", value: "nprobe_tok" }];
  request.headers["user-agent"] = [{ key: "user-agent", value: "curl/8" }];

  readConfig(request);

  assert.equal(request.headers["x-norg-edge-check"], undefined);
  assert.ok(request.headers["user-agent"], "unrelated request headers are untouched");
});

test("deletes config headers even when unset, and leaves the customer's own alone", () => {
  const request = requestWithCustomHeaders({ "x-norg-env": "production", "x-api-key": "theirs" });
  readConfig(request);
  assert.deepEqual(Object.keys(request.origin.custom.customHeaders), ["x-api-key"]);
});

test("survives an origin with no custom headers at all", () => {
  // Still carries the adapter's identity — an unconfigured install is inert,
  // but it still knows which artifact it is.
  for (const request of [{ uri: "/", origin: { custom: { domainName: "e.com" } } }, { uri: "/" }]) {
    assert.deepEqual(readConfig(request), {
      EDGE_SCRIPT_VERSION: "0.5.0",
      EDGE_PLATFORM: "cloudfront",
    });
  }
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
  const headers = controlHeaders({
    SITE_ID: "site-1",
    NORG_SITE_KEY: "k",
    EDGE_SCRIPT_VERSION: "0.3.0",
  });
  assert.equal(headers["X-Norg-Site-Id"], "site-1");
  assert.equal(headers["X-Norg-Site-Key"], "k");
  assert.match(headers["X-Norg-Edge-Version"], /^\d+\.\d+\.\d+$/);

  // A config object with no version still produces a usable header rather than
  // "undefined" reaching NORG.
  assert.equal(controlHeaders({})["X-Norg-Edge-Version"], "unknown");
});

test("an install missing either credential is not configured", () => {
  assert.equal(isConfigured({ SITE_ID: "s", NORG_SITE_KEY: "k" }), true);
  assert.equal(isConfigured({ SITE_ID: "s" }), false);
  assert.equal(isConfigured({ NORG_SITE_KEY: "k" }), false);
  assert.equal(isConfigured({}), false);
});
