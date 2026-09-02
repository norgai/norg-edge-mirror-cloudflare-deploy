/**
 * Unit tests for the shared alternate-format header treatment (MIRROR 03).
 *
 * Covers deriveCanonicalUrl + withAlternateFormatHeaders — the single
 * implementation both r2-proxy-worker.js and edge-router-worker.js import
 * (AC3/AC4): sibling formats get a canonical Link + X-Robots-Tag: noindex,
 * while /mcp.json, /.well-known/mcp.json and .openai.json are exempt.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALTERNATE_FORMAT_EXTENSIONS,
  deriveCanonicalUrl,
  withAlternateFormatHeaders,
} from "./lib/alternate-format.mjs";

const u = (p) => new URL(`https://foxx.ai${p}`);

test("extension set matches the directory r2-proxy contract", () => {
  assert.deepEqual(
    [...ALTERNATE_FORMAT_EXTENSIONS].sort(),
    [".csv", ".json", ".jsonld", ".md", ".pdf"],
  );
});

test("index.md derives canonical to the clean directory URL", () => {
  assert.equal(
    deriveCanonicalUrl(u("/about/index.md"), "/about/index.md"),
    "https://foxx.ai/about/",
  );
});

test("non-index /page.json derives the clean directory URL", () => {
  assert.equal(
    deriveCanonicalUrl(u("/page.json"), "/page.json"),
    "https://foxx.ai/page/",
  );
});

test("an HTML directory path is not an alternate format", () => {
  assert.equal(deriveCanonicalUrl(u("/about/"), "/about/"), null);
});

test("mcp.json is exempt from the canonical treatment", () => {
  assert.equal(deriveCanonicalUrl(u("/about/mcp.json"), "/about/mcp.json"), null);
});

test(".well-known/mcp.json is exempt from the canonical treatment", () => {
  assert.equal(
    deriveCanonicalUrl(u("/.well-known/mcp.json"), "/.well-known/mcp.json"),
    null,
  );
});

test(".openai.json is exempt (separate product resource)", () => {
  assert.equal(
    deriveCanonicalUrl(u("/p/index.openai.json"), "/p/index.openai.json"),
    null,
  );
});

test("withAlternateFormatHeaders sets Link + noindex for a sibling", () => {
  const r = withAlternateFormatHeaders(
    new Response("x"),
    u("/about/index.md"),
    "/about/index.md",
  );
  assert.equal(r.headers.get("Link"), '<https://foxx.ai/about/>; rel="canonical"');
  assert.equal(r.headers.get("X-Robots-Tag"), "noindex");
});

test("withAlternateFormatHeaders leaves mcp.json untouched", () => {
  const r = withAlternateFormatHeaders(
    new Response("x"),
    u("/about/mcp.json"),
    "/about/mcp.json",
  );
  assert.equal(r.headers.get("X-Robots-Tag"), null);
  assert.equal(r.headers.get("Link"), null);
});

test("withAlternateFormatHeaders leaves an HTML page untouched", () => {
  const r = withAlternateFormatHeaders(new Response("x"), u("/about/"), "/about/");
  assert.equal(r.headers.get("X-Robots-Tag"), null);
});
