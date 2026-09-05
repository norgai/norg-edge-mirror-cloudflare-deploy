/**
 * Carve-out paths and the shadow guard.
 *
 * @description Pins the exclusion literals and that none can shadow NORG.
 *
 * These paths are a copy of content-craft's route_scope.py platform lists, so
 * the literals are asserted here the same way constants.mjs is pinned against
 * the Cloudflare worker — a silent edit on either side is the failure mode.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLOUDFRONT_BEHAVIOUR_QUOTA,
  CURATED_ASSET_SUFFIXES,
  DEFAULT_ROUTE_EXCLUSIONS,
  NEXTJS_VERCEL_ROUTE_EXCLUSIONS,
  PROTECTED_PATH_PREFIXES,
  SHOPIFY_ROUTE_EXCLUSIONS,
  WORDPRESS_EXCLUSION_SIGNATURE,
} from "../../core/exclusions.mjs";
import { STATIC_ASSET_SUFFIXES } from "../../core/constants.mjs";

test("Next.js/Vercel exclusions match route_scope.NEXTJS_VERCEL_ROUTE_EXCLUSIONS", () => {
  assert.deepEqual(NEXTJS_VERCEL_ROUTE_EXCLUSIONS, ["/_next/*", "/_vercel/*"]);
});

test("Shopify and WordPress lists match their route_scope counterparts", () => {
  assert.deepEqual(SHOPIFY_ROUTE_EXCLUSIONS, [
    "/cdn/*", "/.well-known/shopify/*", "/recommendations/*", "/checkouts/*",
    "/services/*", "/web-pixels*", "/api/*", "/cdn-cgi/*", "/cart.js", "/shopify_pay/*",
  ]);
  assert.deepEqual(WORDPRESS_EXCLUSION_SIGNATURE, ["/wp-content/*", "/wp-includes/*"]);
});

test("the template default is the Next.js set", () => {
  assert.deepEqual(DEFAULT_ROUTE_EXCLUSIONS, NEXTJS_VERCEL_ROUTE_EXCLUSIONS);
});

test("no default exclusion shadows a NORG-served path", () => {
  // The failure this prevents is silent: CloudFront would simply stop invoking
  // the router for MCP, discovery or the agentic subtree.
  for (const pattern of DEFAULT_ROUTE_EXCLUSIONS) {
    const prefix = pattern.replace(/\*+$/, "");
    for (const protectedPath of PROTECTED_PATH_PREFIXES) {
      assert.equal(
        protectedPath.startsWith(prefix) || prefix.startsWith(protectedPath),
        false,
        `${pattern} shadows ${protectedPath}`,
      );
    }
  }
});

test("the protected list covers every NORG-owned surface the router serves", () => {
  // Cross-checked against the router's own predicates, so a new NORG surface
  // cannot be added without also being protected from a carve-out.
  for (const required of [
    "/mcp", "/sse", "/.well-known/", "/openapi.json", "/openapi.yaml",
    "/llms.txt", "/llms-full.txt", "/agents.md", "/tree.json", "/graph.jsonld",
    "/.norg/", "/ai/",
  ]) {
    assert.ok(PROTECTED_PATH_PREFIXES.includes(required), `missing ${required}`);
  }
});

test("the curated subset is a genuine subset of the shared suffix list", () => {
  for (const suffix of CURATED_ASSET_SUFFIXES) {
    assert.ok(
      STATIC_ASSET_SUFFIXES.has(suffix),
      `${suffix} is not in STATIC_ASSET_SUFFIXES — the two would diverge`,
    );
  }
});

test("a full carve-out set fits CloudFront's behaviour quota", () => {
  // +1 for the default behaviour, which counts toward the same limit.
  const full = DEFAULT_ROUTE_EXCLUSIONS.length + STATIC_ASSET_SUFFIXES.size + 1;
  assert.ok(full <= CLOUDFRONT_BEHAVIOUR_QUOTA, `${full} > ${CLOUDFRONT_BEHAVIOUR_QUOTA}`);
});

test("the curated set leaves ample room in a customer's budget", () => {
  const curated = DEFAULT_ROUTE_EXCLUSIONS.length + CURATED_ASSET_SUFFIXES.length + 1;
  assert.ok(curated <= 20, `${curated} behaviours is too invasive for an attach`);
});
