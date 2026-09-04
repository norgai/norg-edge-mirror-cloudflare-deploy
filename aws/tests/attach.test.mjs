/**
 * The attach CLI's decisions about a live CloudFront distribution.
 *
 * @description Covers the refusals, which are the point of the tool.
 *
 * The risky part of attaching is not the happy path — it is what the tool does
 * when the distribution already has routing on it, or when applying the router
 * would silently change someone's caching. Those are refusals, and a refusal
 * that quietly stopped refusing is the failure worth catching.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { attach, detach, parseArgs, setOriginHeaders } from "../install/attach.mjs";

const OUTPUTS = {
  EdgeRouterVersionArn: "arn:aws:lambda:us-east-1:111:function:norg-router:7",
  ViewerClassifierArn: "arn:aws:cloudfront::111:function/norg-viewer-classifier",
  CachePolicyId: "cache-policy-norg",
  OriginRequestPolicyId: "origin-policy-norg",
  OriginCustomHeaders:
    "x-norg-site-id=site-1, x-norg-api-url=https://api.norg.ai, " +
    "x-norg-content-base=https://edge-content.norg.ai, x-norg-env=production, " +
    "x-norg-strip-fallback=true, x-norg-lazy-render=true",
};

/**
 * A minimal distribution config with one origin and a default behaviour.
 *
 * @param {Object} overrides Behaviour fields to override.
 * @returns {Object} Distribution config.
 */
function distributionConfig(overrides = {}) {
  return {
    Comment: "customer site",
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: "customer-origin",
          DomainName: "origin.example.com",
          CustomHeaders: { Quantity: 1, Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }] },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: "customer-origin",
      CachePolicyId: "managed-caching-optimized",
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FunctionAssociations: { Quantity: 0, Items: [] },
      ...overrides,
    },
  };
}

const OPTIONS = { cachePolicy: "replace", siteKey: "nek_live_secret" };

test("attaching associates both functions and the origin request policy", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const behaviour = config.DefaultCacheBehavior;

  assert.equal(behaviour.LambdaFunctionAssociations.Items[0].EventType, "origin-request");
  assert.equal(
    behaviour.LambdaFunctionAssociations.Items[0].LambdaFunctionARN,
    OUTPUTS.EdgeRouterVersionArn,
  );
  assert.equal(behaviour.FunctionAssociations.Items[0].EventType, "viewer-request");
  assert.equal(behaviour.OriginRequestPolicyId, OUTPUTS.OriginRequestPolicyId);
});

test("the origin-request association includes the body, or MCP POST is dead", () => {
  // The MCP JSON-RPC transport is a POST whose body the router forwards to
  // NORG. Without IncludeBody, CloudFront hands the function an empty body and
  // every MCP client silently falls through to the customer's own 404.
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);

  assert.equal(config.DefaultCacheBehavior.LambdaFunctionAssociations.Items[0].IncludeBody, true);
});

test("attaching REFUSES a distribution that already has an origin-request function", () => {
  const config = distributionConfig({
    LambdaFunctionAssociations: {
      Quantity: 1,
      Items: [{ EventType: "origin-request", LambdaFunctionARN: "arn:aws:lambda:...:theirs:3" }],
    },
  });

  assert.throws(
    () => attach(config, OUTPUTS, OPTIONS),
    /already has an origin-request Lambda@Edge function/,
    "silently replacing someone else's routing is how an install breaks a site",
  );
});

test("attaching REFUSES a distribution that already has a viewer-request function", () => {
  const config = distributionConfig({
    FunctionAssociations: {
      Quantity: 1,
      Items: [{ EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::111:function/theirs" }],
    },
  });

  assert.throws(() => attach(config, OUTPUTS, OPTIONS), /already has a viewer-request CloudFront Function/);
});

test("a viewer-RESPONSE function is not a conflict", () => {
  const config = distributionConfig({
    FunctionAssociations: {
      Quantity: 1,
      Items: [{ EventType: "viewer-response", FunctionARN: "arn:aws:cloudfront::111:function/headers" }],
    },
  });
  assert.doesNotThrow(() => attach(config, OUTPUTS, OPTIONS));
});

test("attaching REFUSES to guess about the cache key", () => {
  const config = distributionConfig();

  assert.throws(
    () => attach(config, OUTPUTS, { ...OPTIONS, cachePolicy: null }),
    /needs `x-norg-agent` in this behaviour's cache key/,
    "changing a customer's caching without being told is not the tool's call",
  );
});

test("--cache-policy=keep leaves the existing policy alone", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, { ...OPTIONS, cachePolicy: "keep" });
  assert.equal(config.DefaultCacheBehavior.CachePolicyId, "managed-caching-optimized");
});

test("attaching preserves the customer's own origin headers", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const names = config.Origins.Items[0].CustomHeaders.Items.map((item) => item.HeaderName);

  assert.ok(names.includes("x-api-key"), "the customer's own headers must survive");
  assert.ok(names.includes("x-norg-site-id"));
  assert.ok(names.includes("x-norg-site-key"));
});

test("re-attaching our OWN router is allowed, so upgrades and key rotation work", () => {
  const config = distributionConfig({
    LambdaFunctionAssociations: {
      Quantity: 1,
      // The same function at an older published version.
      Items: [{ EventType: "origin-request", LambdaFunctionARN: "arn:aws:lambda:us-east-1:111:function:norg-router:5" }],
    },
    FunctionAssociations: {
      Quantity: 1,
      Items: [{ EventType: "viewer-request", FunctionARN: OUTPUTS.ViewerClassifierArn }],
    },
  });

  assert.doesNotThrow(() => attach(config, OUTPUTS, OPTIONS));
  assert.equal(
    config.DefaultCacheBehavior.LambdaFunctionAssociations.Items[0].LambdaFunctionARN,
    OUTPUTS.EdgeRouterVersionArn,
    "re-attaching must move the association to the new version",
  );
});

test("re-attaching replaces the NORG headers instead of duplicating them", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  attach(config, OUTPUTS, { ...OPTIONS, siteKey: "nek_live_rotated" });

  const items = config.Origins.Items[0].CustomHeaders.Items;
  const siteIds = items.filter((item) => item.HeaderName === "x-norg-site-id");
  const key = items.find((item) => item.HeaderName === "x-norg-site-key");

  assert.equal(siteIds.length, 1, "a rotated key must not leave the old one behind");
  assert.equal(key.HeaderValue, "nek_live_rotated");
  assert.equal(items.length, config.Origins.Items[0].CustomHeaders.Quantity);
});

test("the Quantity field always matches the item count", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const behaviour = config.DefaultCacheBehavior;

  // CloudFront rejects a config whose Quantity disagrees with its Items.
  assert.equal(behaviour.LambdaFunctionAssociations.Quantity, 1);
  assert.equal(behaviour.FunctionAssociations.Quantity, 1);
  assert.equal(
    config.Origins.Items[0].CustomHeaders.Quantity,
    config.Origins.Items[0].CustomHeaders.Items.length,
  );
});

test("detaching removes everything attaching added, and nothing else", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  detach(config);

  const behaviour = config.DefaultCacheBehavior;
  assert.deepEqual(behaviour.LambdaFunctionAssociations, { Quantity: 0, Items: [] });
  assert.deepEqual(behaviour.FunctionAssociations, { Quantity: 0, Items: [] });
  assert.deepEqual(config.Origins.Items[0].CustomHeaders, {
    Quantity: 1,
    Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }],
  });
  assert.equal(
    JSON.stringify(config).includes("nek_live_secret"),
    false,
    "detaching must take the credential with it",
  );
});

test("attaching fails loudly when no origin matches the default behaviour", () => {
  const config = distributionConfig();
  config.DefaultCacheBehavior.TargetOriginId = "does-not-exist";
  assert.throws(() => attach(config, OUTPUTS, OPTIONS), /no origin matches/);
});

test("argument parsing accepts both --flag value and --flag=value", () => {
  assert.deepEqual(parseArgs(["--distribution-id", "E1", "--stack=s1", "--apply"]), {
    apply: true,
    detach: false,
    cachePolicy: null,
    distributionId: "E1",
    stack: "s1",
  });
});

test("an unknown argument is rejected rather than ignored", () => {
  assert.throws(() => parseArgs(["--yolo"]), /unknown argument/);
});

test("setOriginHeaders writes the site key that was passed, not one from config", () => {
  const origin = { Id: "o", CustomHeaders: { Quantity: 0, Items: [] } };
  setOriginHeaders(origin, OUTPUTS, { siteKey: "nek_live_x" });
  const key = origin.CustomHeaders.Items.find((item) => item.HeaderName === "x-norg-site-key");
  assert.equal(key.HeaderValue, "nek_live_x");
});
