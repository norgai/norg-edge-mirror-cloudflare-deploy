/**
 * The committed build artifacts in aws/src/.
 *
 * @description Smoke-tests the artifact that actually gets deployed.
 *
 * The unit suites exercise aws/lambda/ sources. This one loads the BUNDLE the
 * CloudFormation templates and the attach CLI upload, exactly as Lambda would,
 * so a build-level break — a bad esbuild target, a stripped export, a wrong
 * module format — cannot pass CI while every source test stays green.
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { cloudFrontEvent, mirrorHit, stubNetwork, GPTBOT_UA, CHROME_UA, SITE_KEY } from "./helpers.mjs";

const awsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const routerPath = join(awsDir, "src", "edge-router-lambda.cjs");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the router bundle loads as CommonJS and exports a handler", () => {
  const bundle = require(routerPath);
  assert.equal(typeof bundle.handler, "function", "Lambda resolves exports.handler");
});

test("the heartbeat bundle loads and exports a handler", () => {
  const bundle = require(join(awsDir, "src", "heartbeat-lambda.cjs"));
  assert.equal(typeof bundle.handler, "function");
});

test("the built router serves a mirror to a verified agent", async () => {
  const { handler } = require(routerPath);
  stubNetwork({ mirror: () => mirrorHit("<html><body>MIRROR</body></html>") });

  const result = await handler(cloudFrontEvent({ headers: { "user-agent": GPTBOT_UA } }));

  assert.equal(result.status, "200");
  assert.equal(result.headers["x-norg-edge"][0].value, "mirror");
  assert.equal(result.headers["cache-control"][0].value, "private, no-store");
  assert.match(result.body, /MIRROR/);
});

test("the built router leaves a human alone and leaks no credential", async () => {
  const { handler } = require(routerPath);
  stubNetwork({ mirror: () => mirrorHit() });

  const result = await handler(cloudFrontEvent({ headers: { "user-agent": CHROME_UA } }));

  assert.equal(typeof result.status, "undefined", "a human must get the untouched origin");
  assert.equal(JSON.stringify(result).includes(SITE_KEY), false);
});

test("the router bundle is self-contained", () => {
  // Lambda@Edge supports no layers, so an unresolved bare require() would fail
  // at deploy time rather than at build time.
  const source = readFileSync(routerPath, "utf8");
  assert.equal(/\brequire\s*\(\s*["'](?!node:)/.test(source), false);
});

test("no NORG-internal secret name reaches a customer account", () => {
  for (const artifact of ["edge-router-lambda.cjs", "heartbeat-lambda.cjs", "viewer-classifier.js"]) {
    const source = readFileSync(join(awsDir, "src", artifact), "utf8");
    for (const forbidden of [
      "CRAWLER_EVENT_SECRET",
      "WORKER_AUTH_SECRET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "INTERNAL_API_KEY",
      "EDGE_BUCKET",
    ]) {
      assert.equal(source.includes(forbidden), false, `${artifact} leaks ${forbidden}`);
    }
  }
});

test("the CloudFront Function artifact is under the 10 KB limit", () => {
  const bytes = statSync(join(awsDir, "src", "viewer-classifier.js")).size;
  assert.ok(bytes < 10 * 1024, `${bytes} bytes`);
});

test("the bundle reports the same version as the source", async () => {
  const { EDGE_SCRIPT_VERSION } = await import("../lambda/lib/config.js");
  const source = readFileSync(routerPath, "utf8");
  assert.ok(
    source.includes(`"${EDGE_SCRIPT_VERSION}"`),
    "a stale bundle would report the wrong version on every heartbeat",
  );
});
