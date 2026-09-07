/**
 * The committed Bunny bundle: freshness and the guards the build enforces.
 *
 * @description dist/edge-router-bunny.js is what install.mjs uploads.
 *
 * Bunny's API takes the script as one string, so the bundle IS the deployable.
 * A source edit without a rebuild would ship stale code while the repository
 * looked correct, which is the failure this suite exists to catch.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const bunnyDir = dirname(here);
const bundlePath = join(bunnyDir, "dist", "edge-router-bunny.js");
const bundle = readFileSync(bundlePath, "utf8");

test("the committed bundle is the one the build produces", () => {
  const before = bundle;
  execFileSync("node", [join(bunnyDir, "build.mjs")], { stdio: "pipe" });
  assert.equal(readFileSync(bundlePath, "utf8"), before, "run: node bunny/build.mjs");
});

test("the Bunny SDK is the only surviving import, and it is pinned", () => {
  const imports = [...bundle.matchAll(/^\s*import\s+[^\n]*?from\s+["']([^"']+)["']/gm)].map(
    (m) => m[1],
  );
  const external = imports.filter((spec) => !spec.startsWith("node:"));
  assert.deepEqual(external, ["@bunny.net/edgescript-sdk@0.12.1"]);
});

test("only the before-cache-free hook is registered", () => {
  // Registering onClientRequest on an account without the before-cache preview
  // makes the SDK throw at startup, and a middleware script that fails to start
  // makes the pull zone answer 400 for EVERY request. Observed on a live zone.
  assert.equal(bundle.includes("onOriginRequest"), true);
  assert.equal(bundle.includes("onClientRequest"), false);
  assert.equal(bundle.includes("onClientResponse"), false);
});

test("the bundle carries no credential and no NORG-internal name", () => {
  for (const forbidden of [
    "nek_",
    "AccessKey",
    "CRAWLER_EVENT_SECRET",
    "WORKER_AUTH_SECRET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "INTERNAL_API_KEY",
    "EDGE_BUCKET",
  ]) {
    assert.equal(bundle.includes(forbidden), false, `bundle leaks "${forbidden}"`);
  }
});

test("the bundle bakes NO fallback bot-pattern list", () => {
  // A baked list would survive NORG revoking an install — the exact loophole
  // the entitlement gate closes. UNENTITLED must stay empty.
  const unentitled = /UNENTITLED = Object\.freeze\(\{[\s\S]*?\}\)/.exec(bundle);
  assert.ok(unentitled, "UNENTITLED must be present in the bundle");
  assert.match(unentitled[0], /patterns:\s*\[\]/);
  assert.match(unentitled[0], /entitled:\s*false/);
});

test("the search-bot floor is present verbatim", () => {
  for (const bot of [
    "googlebot",
    "bingbot",
    "applebot",
    "duckduckbot",
    "baiduspider",
    "yandex",
    "slurp",
  ]) {
    assert.ok(bundle.includes(`"${bot}"`), `search-bot floor is missing ${bot}`);
  }
});

test("the bundle parses", () => {
  execFileSync("node", ["--check", bundlePath], { stdio: "pipe" });
});
