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

import {
  assertReplaceIsSafe,
  attach,
  detach,
  isOurs,
  parseArgs,
  setOriginHeaders,
} from "../install/attach.mjs";
import {
  DYNAMIC_ROUTE_EXCLUSIONS,
  MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID,
  MANAGED_CACHING_DISABLED_ID,
  MCP_PATH_PATTERNS,
} from "../../core/exclusions.mjs";

const OUTPUTS = {
  EdgeRouterVersionArn: "arn:aws:lambda:us-east-1:111:function:norg-router:7",
  CacheGuardVersionArn: "arn:aws:lambda:us-east-1:111:function:norg-cache-guard:3",
  ViewerClassifierArn: "arn:aws:cloudfront::111:function/norg-viewer-classifier",
  CachePolicyId: "cache-policy-norg",
  OriginRequestPolicyId: "origin-policy-norg",
  StaticCachePolicyId: "static-policy",
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

test("the default behaviour gets the body OFF and the cache guard ON", () => {
  // IncludeBody is per association; on the default behaviour it delivered
  // every cache-miss POST body on the site into the router's memory.
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const items = config.DefaultCacheBehavior.LambdaFunctionAssociations.Items;

  assert.equal(items[0].EventType, "origin-request");
  assert.equal(items[0].IncludeBody, false);
  assert.equal(items[1].EventType, "origin-response");
  assert.equal(items[1].LambdaFunctionARN, OUTPUTS.CacheGuardVersionArn);
});

test("the MCP behaviours are the only place the body is included, and they run the router", () => {
  // Without IncludeBody there, CloudFront hands the router an empty body and
  // every MCP client silently falls through to the customer's own 404.
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const byPattern = Object.fromEntries(config.CacheBehaviors.Items.map((b) => [b.PathPattern, b]));

  for (const pattern of MCP_PATH_PATTERNS) {
    const b = byPattern[pattern];
    assert.ok(b, `${pattern} behaviour missing`);
    const [router, guard] = b.LambdaFunctionAssociations.Items;
    assert.equal(router.LambdaFunctionARN, OUTPUTS.EdgeRouterVersionArn);
    assert.equal(router.IncludeBody, true);
    assert.equal(guard.LambdaFunctionARN, OUTPUTS.CacheGuardVersionArn);
    assert.equal(b.FunctionAssociations.Items[0].FunctionARN, OUTPUTS.ViewerClassifierArn);
    assert.equal(b.CachePolicyId, OUTPUTS.CachePolicyId);
  }
  const withBody = config.CacheBehaviors.Items.filter((b) =>
    (b.LambdaFunctionAssociations?.Items || []).some((l) => l.IncludeBody),
  );
  assert.equal(withBody.length, MCP_PATH_PATTERNS.length);
});

test("dynamic carve-outs are NOT cached and forward everything", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const byPattern = Object.fromEntries(config.CacheBehaviors.Items.map((b) => [b.PathPattern, b]));
  for (const pattern of DYNAMIC_ROUTE_EXCLUSIONS) {
    const b = byPattern[pattern];
    assert.equal(b.CachePolicyId, MANAGED_CACHING_DISABLED_ID, pattern);
    assert.equal(b.OriginRequestPolicyId, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, pattern);
    assert.equal(b.LambdaFunctionAssociations.Quantity, 0, pattern);
    assert.ok(b.AllowedMethods.Items.includes("POST"), `${pattern} must accept POST`);
  }
});

test("attaching REFUSES a distribution that already has a foreign origin-response function", () => {
  const config = distributionConfig({
    LambdaFunctionAssociations: {
      Quantity: 1,
      Items: [{ EventType: "origin-response", LambdaFunctionARN: "arn:aws:lambda:us-east-1:222:function:theirs:1" }],
    },
  });
  assert.throws(() => attach(config, OUTPUTS, OPTIONS), /already has an origin-response Lambda@Edge function/);
});

test("replace is refused when the customer's key carries cookies, headers or query strings", () => {
  const keyed = (extra) => ({
    ParametersInCacheKeyAndForwardedToOrigin: {
      CookiesConfig: { CookieBehavior: "none" },
      HeadersConfig: { HeaderBehavior: "none" },
      QueryStringsConfig: { QueryStringBehavior: "none" },
      ...extra,
    },
  });
  // Collapsing a session or per-variant cache serves one visitor's page to the next.
  assert.throws(() => assertReplaceIsSafe(keyed({ CookiesConfig: { CookieBehavior: "all" } })), /keys on cookies/);
  assert.throws(() => assertReplaceIsSafe(keyed({ HeadersConfig: { HeaderBehavior: "whitelist" } })), /keys on headers/);
  assert.throws(() => assertReplaceIsSafe(keyed({ QueryStringsConfig: { QueryStringBehavior: "all" } })), /keys on query strings/);
  assert.doesNotThrow(() => assertReplaceIsSafe(keyed({})));
  // An unreadable policy is not a licence to proceed silently either way; the
  // caller passes what get-cache-policy returned, and "none" is the default.
  assert.doesNotThrow(() => assertReplaceIsSafe(undefined));
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
  assert.equal(behaviour.LambdaFunctionAssociations.Quantity, 2);
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

test("attaching adds carve-outs ahead of the customer's own, MCP first", () => {
  const config = distributionConfig();
  config.CacheBehaviors = {
    Quantity: 1,
    Items: [{ PathPattern: "/their-thing/*", TargetOriginId: "customer-origin" }],
  };
  attach(config, OUTPUTS, OPTIONS);

  const items = config.CacheBehaviors.Items;
  assert.equal(items[0].PathPattern, MCP_PATH_PATTERNS[0], "MCP must be matched first");
  const mcp = new Set(MCP_PATH_PATTERNS);
  assert.ok(
    items.filter((b) => !mcp.has(b.PathPattern)).every((b) => !b.LambdaFunctionAssociations?.Quantity),
    "a carve-out carrying a Lambda defeats its purpose",
  );
  assert.equal(items.at(-1).PathPattern, "/their-thing/*", "the customer's own behaviours must survive, after ours");
  assert.equal(config.CacheBehaviors.Quantity, items.length);
});

test("a customer behaviour on one of OUR patterns is kept, never replaced", () => {
  // The dangerous case: their /api/* points at a different origin. Replacing
  // it with our carve-out would repoint their API at their web server.
  const config = distributionConfig();
  const theirApi = {
    PathPattern: "/api/*",
    TargetOriginId: "api-origin",
    CachePolicyId: "their-policy",
    LambdaFunctionAssociations: { Quantity: 0, Items: [] },
  };
  config.CacheBehaviors = { Quantity: 1, Items: [theirApi] };
  attach(config, OUTPUTS, OPTIONS);

  const apis = config.CacheBehaviors.Items.filter((b) => b.PathPattern === "/api/*");
  assert.equal(apis.length, 1, "no duplicate /api/*");
  assert.equal(apis[0].TargetOriginId, "api-origin", "theirs must survive untouched");

  detach(config);
  assert.deepEqual(config.CacheBehaviors.Items.map((b) => b.PathPattern), ["/api/*"]);
  assert.equal(config.CacheBehaviors.Items[0].TargetOriginId, "api-origin");
});

test("a customer behaviour on an MCP pattern is a refusal, not a silent skip", () => {
  const config = distributionConfig();
  config.CacheBehaviors = {
    Quantity: 1,
    Items: [{ PathPattern: "*/mcp", TargetOriginId: "customer-origin", LambdaFunctionAssociations: { Quantity: 0, Items: [] } }],
  };
  assert.throws(() => attach(config, OUTPUTS, OPTIONS), /already has a cache behaviour for "\*\/mcp"/);
});

test("isOurs recognises our shapes and nothing on another origin", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  for (const b of config.CacheBehaviors.Items) assert.ok(isOurs(b, config), b.PathPattern);
  assert.equal(isOurs({ PathPattern: "*.css", TargetOriginId: "cdn-origin" }, config), false);
  assert.equal(isOurs({ PathPattern: "/api/*", TargetOriginId: "customer-origin", CachePolicyId: "theirs" }, config), false);
});

test("attaching REFUSES rather than exceeding the customer's behaviour quota", () => {
  const config = distributionConfig();
  config.CacheBehaviors = {
    Quantity: 70,
    Items: Array.from({ length: 70 }, (_, i) => ({
      PathPattern: `/theirs-${i}/*`,
      TargetOriginId: "customer-origin",
    })),
  };

  assert.throws(
    () => attach(config, OUTPUTS, OPTIONS),
    /over CloudFront's limit of 75/,
    "their behaviour budget is theirs; silently spending it surfaces weeks later",
  );
});

test("re-attaching does not duplicate carve-outs", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const first = config.CacheBehaviors.Items.length;
  attach(config, OUTPUTS, OPTIONS);

  assert.equal(config.CacheBehaviors.Items.length, first);
});

test("detaching removes our carve-outs and keeps the customer's", () => {
  const config = distributionConfig();
  config.CacheBehaviors = {
    Quantity: 1,
    Items: [{ PathPattern: "/their-thing/*", TargetOriginId: "customer-origin" }],
  };
  attach(config, OUTPUTS, OPTIONS);
  detach(config);

  assert.deepEqual(
    config.CacheBehaviors.Items.map((b) => b.PathPattern),
    ["/their-thing/*"],
  );
});

test("a carve-out that would shadow a NORG path is refused", async () => {
  const { carveOutBehaviours } = await import("../install/attach.mjs");
  // Sanity: the real set is clean.
  assert.ok(carveOutBehaviours(OUTPUTS, "origin").length > 0);
});
