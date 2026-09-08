/**
 * The origin-response cache guard.
 *
 * @description Only the human bucket may cache origin bytes; everything else
 * is marked no-store, and nothing here can ever throw into a 502.
 *
 * Loaded from the COPIED artifact in aws/src/, not the source, because that is
 * the file the templates inline — a test against the source would pass while a
 * stale copy shipped. bundle.test.mjs pins the two equal.
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const guard = require(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cache-guard-lambda.cjs"));

/**
 * Build an origin-response event.
 *
 * @param {string|undefined} bucket x-norg-agent value on the origin request.
 * @param {Object} responseHeaders CloudFront-shaped response headers.
 * @returns {Object} Lambda@Edge event.
 */
function event(bucket, responseHeaders = {}) {
  const headers = {};
  if (bucket !== undefined) headers["x-norg-agent"] = [{ key: "x-norg-agent", value: bucket }];
  return {
    Records: [
      {
        cf: {
          request: { uri: "/page", headers },
          response: { status: "200", headers: responseHeaders },
        },
      },
    ],
  };
}

const cacheable = { "cache-control": [{ key: "Cache-Control", value: "public, max-age=3600" }] };

test("the agent bucket never caches an origin page", async () => {
  // The finding this file exists for: a spoofed GPTBot is passed through, and
  // without this the origin page would be cached under agent=1 for an hour —
  // served to every real crawler after it, with the router never running.
  const response = await guard.handler(event("1", { ...cacheable }));
  assert.equal(response.headers["cache-control"][0].value, "private, no-store");
});

test("the human bucket is left exactly as the origin sent it", async () => {
  const response = await guard.handler(event("0", { ...cacheable }));
  assert.equal(response.headers["cache-control"][0].value, "public, max-age=3600");
});

test("the probe bucket is not cacheable either", async () => {
  const response = await guard.handler(event("probe", { ...cacheable }));
  assert.equal(response.headers["cache-control"][0].value, "private, no-store");
});

test("a missing stamp is treated as not-human, never as human", async () => {
  // Absent means something upstream did not run; caching on that is a guess.
  const response = await guard.handler(event(undefined, { ...cacheable }));
  assert.equal(response.headers["cache-control"][0].value, "private, no-store");
});

test("a NORG-served response (origin switch) is not touched", async () => {
  const headers = {
    "x-norg-edge": [{ key: "X-Norg-Edge", value: "mirror" }],
    "cache-control": [{ key: "Cache-Control", value: "private, no-store" }],
  };
  const response = await guard.handler(event("1", headers));
  assert.deepEqual(response.headers, headers);
});

test("Expires is removed alongside, so it cannot outvote no-store", async () => {
  const headers = { ...cacheable, expires: [{ key: "Expires", value: "Thu, 01 Jan 2099 00:00:00 GMT" }] };
  const response = await guard.handler(event("1", headers));
  assert.equal(response.headers.expires, undefined);
});

test("a malformed event returns the response untouched rather than throwing", async () => {
  // A throw here is a 502 on the customer's site. Rule 1.
  const broken = { Records: [{ cf: { request: null, response: { status: "200", headers: {} } } }] };
  const response = await guard.handler(broken);
  assert.equal(response.status, "200");
});

test("cacheable() is exactly: human bucket, or NORG-served", () => {
  assert.equal(guard.__test_cacheable("0", false), true);
  assert.equal(guard.__test_cacheable("1", true), true);
  assert.equal(guard.__test_cacheable("1", false), false);
  assert.equal(guard.__test_cacheable(undefined, false), false);
});
