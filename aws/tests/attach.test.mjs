/**
 * The attach CLI's decisions about a live CloudFront distribution.
 *
 * @description Covers the refusals, which are the point of the tool.
 *
 * The risky part of attaching is not the happy path — it is what the tool does
 * when the distribution already has routing on it. That is a refusal, and a
 * refusal that quietly stopped refusing is the failure worth catching. The
 * other thing worth pinning is the one caching change the tool makes on
 * purpose: pages stop being cached at the edge, and the dry run says so.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  attach,
  attachGate,
  detach,
  detachGate,
  isOurs,
  parseArgs,
  parseHeaderPairs,
  quotaLines,
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
  OriginRequestPolicyId: "origin-policy-norg",
  StaticCachePolicyId: "static-policy",
  OriginCustomHeaders:
    "x-norg-site-id=site-1, x-norg-api-url=https://api.norg.ai, " +
    "x-norg-content-base=https://edge-content.norg.ai, x-norg-env=production, " +
    "x-norg-strip-fallback=true, x-norg-lazy-render=true, " +
    "x-norg-secret-arn=arn:aws:secretsmanager:us-east-1:111:secret:k, " +
    "x-norg-probe-token=nprobe_tok",
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

const OPTIONS = { siteKey: "nek_live_secret" };

test("attaching associates the router and the origin request policy, and nothing else", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const behaviour = config.DefaultCacheBehavior;

  assert.equal(behaviour.LambdaFunctionAssociations.Items.length, 1);
  assert.equal(behaviour.LambdaFunctionAssociations.Items[0].EventType, "origin-request");
  assert.equal(
    behaviour.LambdaFunctionAssociations.Items[0].LambdaFunctionARN,
    OUTPUTS.EdgeRouterVersionArn,
  );
  assert.deepEqual(
    behaviour.FunctionAssociations,
    { Quantity: 0, Items: [] },
    "no viewer-request function is added: there is no cache key to stamp",
  );
  assert.equal(behaviour.OriginRequestPolicyId, OUTPUTS.OriginRequestPolicyId);
});

test("the default behaviour gets the body OFF and stops caching pages", () => {
  // IncludeBody is per association; on the default behaviour it delivered
  // every POST body on the site into the router's memory.
  const config = distributionConfig();
  const changes = attach(config, OUTPUTS, OPTIONS);
  const behaviour = config.DefaultCacheBehavior;

  assert.equal(behaviour.LambdaFunctionAssociations.Items[0].IncludeBody, false);
  assert.equal(behaviour.CachePolicyId, MANAGED_CACHING_DISABLED_ID);
  const line = changes.find((c) => c.startsWith("cache policy"));
  assert.match(line, /managed-caching-optimized -> CachingDisabled/);
  assert.match(
    line,
    /HTML is no longer cached at the edge/,
    "the one caching change must be stated in the dry run, in those words",
  );
});

test("a distribution already on CachingDisabled reports the policy unchanged", () => {
  const config = distributionConfig({ CachePolicyId: MANAGED_CACHING_DISABLED_ID });
  const changes = attach(config, OUTPUTS, OPTIONS);
  assert.ok(changes.some((c) => /cache policy\s+CachingDisabled \(already\)/.test(c)));
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
    assert.equal(b.LambdaFunctionAssociations.Items.length, 1, `${pattern} runs only the router`);
    const [router] = b.LambdaFunctionAssociations.Items;
    assert.equal(router.LambdaFunctionARN, OUTPUTS.EdgeRouterVersionArn);
    assert.equal(router.IncludeBody, true);
    assert.equal(b.FunctionAssociations, undefined);
    assert.equal(b.CachePolicyId, MANAGED_CACHING_DISABLED_ID, `${pattern} is never cached`);
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

test("a foreign origin-response function is not a conflict: the router needs no such slot", () => {
  // 0.5.x needed origin-response for the cache guard. With no page caching
  // there is nothing to guard, so a customer's own origin-response function
  // stays exactly where it is.
  const theirs = { EventType: "origin-response", LambdaFunctionARN: "arn:aws:lambda:us-east-1:222:function:theirs:1" };
  const config = distributionConfig({
    LambdaFunctionAssociations: { Quantity: 1, Items: [theirs] },
  });
  assert.doesNotThrow(() => attach(config, OUTPUTS, OPTIONS));
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

test("a customer's own CloudFront Functions are left exactly as they are", () => {
  // The router attaches nothing at viewer-request or viewer-response, so
  // neither slot is a conflict and neither is touched — on attach or detach.
  const theirs = {
    Quantity: 2,
    Items: [
      { EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::111:function/theirs" },
      { EventType: "viewer-response", FunctionARN: "arn:aws:cloudfront::111:function/headers" },
    ],
  };
  const config = distributionConfig({ FunctionAssociations: structuredClone(theirs) });
  assert.doesNotThrow(() => attach(config, OUTPUTS, OPTIONS));
  assert.deepEqual(config.DefaultCacheBehavior.FunctionAssociations, theirs);
  detach(config);
  assert.deepEqual(config.DefaultCacheBehavior.FunctionAssociations, theirs);
});

test("attaching preserves the customer's own origin headers", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const names = config.Origins.Items[0].CustomHeaders.Items.map((item) => item.HeaderName);

  assert.ok(names.includes("x-api-key"), "the customer's own headers must survive");
  assert.ok(names.includes("x-norg-site-id"));
  assert.ok(names.includes("x-norg-secret-arn"));
  assert.equal(
    names.includes("x-norg-site-key"),
    false,
    "the key itself must never be written into the distribution",
  );
});

test("re-attaching our OWN router is allowed, so upgrades and key rotation work", () => {
  const config = distributionConfig({
    LambdaFunctionAssociations: {
      Quantity: 1,
      // The same function at an older published version.
      Items: [{ EventType: "origin-request", LambdaFunctionARN: "arn:aws:lambda:us-east-1:111:function:norg-router:5" }],
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
  attach(config, OUTPUTS, OPTIONS);

  const items = config.Origins.Items[0].CustomHeaders.Items;
  const siteIds = items.filter((item) => item.HeaderName === "x-norg-site-id");
  const arns = items.filter((item) => item.HeaderName === "x-norg-secret-arn");

  assert.equal(siteIds.length, 1, "re-attaching must not leave a duplicate behind");
  assert.equal(arns.length, 1);
  assert.equal(items.length, config.Origins.Items[0].CustomHeaders.Quantity);
});

test("the Quantity field always matches the item count", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  const behaviour = config.DefaultCacheBehavior;

  // CloudFront rejects a config whose Quantity disagrees with its Items.
  assert.equal(behaviour.LambdaFunctionAssociations.Quantity, 1);
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
    layout: "lambda",
    distributionId: "E1",
    stack: "s1",
  });
});

test("the retired --cache-policy flag is rejected, not silently accepted", () => {
  // An operator on an old runbook must find out the choice no longer exists,
  // rather than believe they kept their HTML cache.
  assert.throws(() => parseArgs(["--cache-policy=keep"]), /unknown argument/);
});

test("the quota table names every Lambda@Edge region and warns on a low one", () => {
  const lines = quotaLines([
    { region: "us-east-1", value: 1000 },
    { region: "ap-southeast-2", value: 10 },
    { region: "eu-west-1", value: null },
  ]);
  assert.ok(lines.some((l) => /us-east-1\s+1000$/.test(l)));
  assert.ok(lines.some((l) => /ap-southeast-2\s+10\s+<- LOW/.test(l)), "a quota of 10 is 100 rps, then 503s");
  assert.ok(lines.some((l) => /eu-west-1\s+unreadable/.test(l)), "an unreadable region is reported, never fatal");
  assert.ok(lines.some((l) => /L-B99A9384/.test(l) && /ap-southeast-2/.test(l)), "the warning says which quota to raise, and where");
  assert.equal(quotaLines([{ region: "us-east-1", value: 1000 }]).length, 1, "no warning when nothing is low");
});

test("an unknown argument is rejected rather than ignored", () => {
  assert.throws(() => parseArgs(["--yolo"]), /unknown argument/);
});

test("setOriginHeaders writes no credential of any kind", () => {
  // The CLI used to inject the site key here, which put it in reach of anyone
  // with cloudfront:GetDistributionConfig. It now writes only what the stack
  // published, and the key stays in Secrets Manager.
  const origin = { Id: "o", CustomHeaders: { Quantity: 0, Items: [] } };
  setOriginHeaders(origin, OUTPUTS, { siteKey: "nek_live_x" });

  const written = origin.CustomHeaders.Items;
  assert.equal(
    JSON.stringify(written).includes("nek_live_x"),
    false,
    "a key handed to the CLI must not reach the distribution",
  );
  const arn = written.find((item) => item.HeaderName === "x-norg-secret-arn");
  assert.equal(arn.HeaderValue, "arn:aws:secretsmanager:us-east-1:111:secret:k");
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

// ---------------------------------------------------------------------------
// The gate layout (--layout gate): one CloudFront Function, no Lambda.
// ---------------------------------------------------------------------------

const GATE_OUTPUTS = {
  FunctionArn: "arn:aws:cloudfront::111:function/norg-edge-gate-site-1",
  FunctionName: "norg-edge-gate-site-1",
  ReceptionistHost: "edge-content.norg.ai",
  ReceptionistOriginId: "norg-receptionist",
  CustomerOriginId: "customer-origin",
  GateVersion: "0.1.0",
  OriginCustomHeaders: "x-norg-site-id=site-1, x-norg-env=production",
};
const GATE_OPTIONS = {
  layout: "gate",
  originHeaders: "X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=nmt_secret_token",
};

test("gate: the function goes on viewer-request, no Lambda is added, and the cache policy is left alone", () => {
  const config = distributionConfig();
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const behaviour = config.DefaultCacheBehavior;

  assert.deepEqual(behaviour.FunctionAssociations, {
    Quantity: 1,
    Items: [{ EventType: "viewer-request", FunctionARN: GATE_OUTPUTS.FunctionArn }],
  });
  assert.deepEqual(behaviour.LambdaFunctionAssociations, { Quantity: 0, Items: [] });
  assert.equal(behaviour.OriginRequestPolicyId, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, "gate headers and the query string must reach the receptionist");
  assert.equal(behaviour.CachePolicyId, "managed-caching-optimized", "humans never reach NORG code: HTML caching is not the gate's business");
  assert.ok(changes.some((c) => /cache policy\s+managed-caching-optimized left as it is/.test(c)), "the dry run says the cache policy is untouched");
  assert.ok(changes.some((c) => /origin request\s+managed-caching-optimized|origin request\s+\(none\) -> AllViewerExceptHostHeader/.test(c)));
});

test("gate: the receptionist origin is added, https-only, with the stack headers and the caller's token; the customer origin is untouched", () => {
  const config = distributionConfig();
  attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);

  assert.equal(config.Origins.Quantity, 2);
  const receptionist = config.Origins.Items.find((o) => o.Id === "norg-receptionist");
  assert.ok(receptionist, "receptionist origin missing");
  assert.equal(receptionist.DomainName, "edge-content.norg.ai");
  assert.equal(receptionist.CustomOriginConfig.OriginProtocolPolicy, "https-only");
  assert.deepEqual(receptionist.CustomOriginConfig.OriginSslProtocols, { Quantity: 1, Items: ["TLSv1.2"] });
  const headers = Object.fromEntries(receptionist.CustomHeaders.Items.map((h) => [h.HeaderName.toLowerCase(), h.HeaderValue]));
  assert.equal(headers["x-norg-mirror-token"], "nmt_secret_token");
  assert.equal(headers["x-norg-site-id"], "site-1");
  assert.equal(headers["x-norg-env"], "production");
  assert.equal(receptionist.CustomHeaders.Quantity, receptionist.CustomHeaders.Items.length);
  assert.equal(receptionist.CustomHeaders.Items.filter((h) => h.HeaderName.toLowerCase() === "x-norg-site-id").length, 1, "the caller's X-Norg-Site-Id and the stack's x-norg-site-id are one header");

  const customer = config.Origins.Items.find((o) => o.Id === "customer-origin");
  assert.deepEqual(customer.CustomHeaders, { Quantity: 1, Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }] }, "nothing is written on the customer's own origin");
});

test("gate: attaching REFUSES without the mirror token — a tokenless receptionist 404s everything, silently", () => {
  const config = distributionConfig();
  assert.throws(() => attachGate(config, GATE_OUTPUTS, { layout: "gate" }), /x-norg-mirror-token/);
  assert.throws(() => attachGate(config, GATE_OUTPUTS, { layout: "gate", originHeaders: "X-Norg-Site-Id=site-1" }), /x-norg-mirror-token/);
});

test("gate: attaching REFUSES when the stack's CustomerOriginId is not the default behaviour's origin", () => {
  // The function names the customer origin by Id in its origin group; a wrong
  // Id fails every agent request at the edge while humans see nothing wrong.
  const config = distributionConfig();
  assert.throws(
    () => attachGate(config, { ...GATE_OUTPUTS, CustomerOriginId: "web" }, GATE_OPTIONS),
    /CustomerOriginId is "web" but the default behaviour points at "customer-origin"/,
  );
});

test("gate: the old viewer-classifier is replaced, a foreign viewer-request function is refused, viewer-response is kept", () => {
  const classifier = { EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::111:function/norg-edge-cloudfront-norg-viewer-classifier" };
  const theirs = { EventType: "viewer-response", FunctionARN: "arn:aws:cloudfront::111:function/their-headers" };
  const config = distributionConfig({ FunctionAssociations: { Quantity: 2, Items: [classifier, theirs] } });
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  assert.deepEqual(config.DefaultCacheBehavior.FunctionAssociations.Items, [
    theirs,
    { EventType: "viewer-request", FunctionARN: GATE_OUTPUTS.FunctionArn },
  ]);
  assert.ok(changes.some((c) => c.includes("replaces") && c.includes("viewer-classifier")));

  const foreign = distributionConfig({
    FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::222:function/their-router" }] },
  });
  assert.throws(() => attachGate(foreign, GATE_OUTPUTS, GATE_OPTIONS), /already has a viewer-request CloudFront Function/);
});

test("gate: attaching over a Lambda-layout install removes our router and its MCP/static carve-outs; a foreign Lambda is refused", () => {
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS); // the old layout, in full
  assert.ok(config.CacheBehaviors.Items.some((b) => MCP_PATH_PATTERNS.includes(b.PathPattern)));

  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const behaviour = config.DefaultCacheBehavior;
  assert.deepEqual(behaviour.LambdaFunctionAssociations, { Quantity: 0, Items: [] });
  assert.ok(changes.some((c) => /removed 1 NORG Lambda@Edge association/.test(c)));
  const patterns = config.CacheBehaviors.Items.map((b) => b.PathPattern);
  assert.deepEqual(patterns, DYNAMIC_ROUTE_EXCLUSIONS, "only the dynamic carve-outs remain: no MCP, no static");
  assert.ok(config.CacheBehaviors.Items.every((b) => !b.LambdaFunctionAssociations?.Quantity && !b.FunctionAssociations?.Quantity));

  const foreign = distributionConfig({
    LambdaFunctionAssociations: { Quantity: 1, Items: [{ EventType: "origin-request", LambdaFunctionARN: "arn:aws:lambda:us-east-1:222:function:theirs:3" }] },
  });
  assert.throws(() => attachGate(foreign, GATE_OUTPUTS, GATE_OPTIONS), /already has an origin-request Lambda@Edge function/);
});

test("gate: the carve-outs are the dynamic group only, listed ahead of the customer's own", () => {
  const config = distributionConfig();
  config.CacheBehaviors = { Quantity: 1, Items: [{ PathPattern: "/their-thing/*", TargetOriginId: "customer-origin" }] };
  const changes = attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const patterns = config.CacheBehaviors.Items.map((b) => b.PathPattern);
  assert.deepEqual(patterns, [...DYNAMIC_ROUTE_EXCLUSIONS, "/their-thing/*"]);
  for (const b of config.CacheBehaviors.Items.slice(0, -1)) {
    assert.equal(b.CachePolicyId, MANAGED_CACHING_DISABLED_ID, b.PathPattern);
    assert.equal(b.OriginRequestPolicyId, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, b.PathPattern);
    assert.ok(b.AllowedMethods.Items.includes("POST"), `${b.PathPattern} must accept POST`);
  }
  assert.ok(changes.some((c) => /no MCP or static carve-outs/.test(c)), "the dry run says what is NOT carved out");
  assert.equal(config.CacheBehaviors.Quantity, config.CacheBehaviors.Items.length);
});

test("gate: re-attaching is idempotent — one receptionist origin, one association, no duplicate carve-outs", () => {
  const config = distributionConfig();
  attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);
  const once = structuredClone(config);
  const changes = attachGate(config, GATE_OUTPUTS, { ...GATE_OPTIONS, originHeaders: "X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=nmt_rotated" });
  assert.equal(config.Origins.Quantity, 2);
  assert.equal(config.DefaultCacheBehavior.FunctionAssociations.Quantity, 1);
  assert.equal(config.CacheBehaviors.Items.length, once.CacheBehaviors.Items.length);
  const receptionist = config.Origins.Items.find((o) => o.Id === "norg-receptionist");
  assert.equal(receptionist.CustomHeaders.Items.find((h) => h.HeaderName === "X-Norg-Mirror-Token").HeaderValue, "nmt_rotated", "re-attaching is how a token rotation lands");
  assert.ok(changes.some((c) => /origin\s+~norg-receptionist/.test(c)), "the dry run says the origin is replaced, not added");
});

test("gate: a receptionist Id that is the customer's default origin is refused", () => {
  const config = distributionConfig();
  assert.throws(
    () => attachGate(config, { ...GATE_OUTPUTS, ReceptionistOriginId: "customer-origin" }, GATE_OPTIONS),
    /is your default origin's Id/,
  );
});

test("gate: detaching removes the function, the receptionist origin, every x-norg header and our carve-outs — and nothing else", () => {
  const theirs = { EventType: "viewer-response", FunctionARN: "arn:aws:cloudfront::111:function/their-headers" };
  const config = distributionConfig({ FunctionAssociations: { Quantity: 1, Items: [theirs] } });
  config.CacheBehaviors = { Quantity: 1, Items: [{ PathPattern: "/their-thing/*", TargetOriginId: "customer-origin" }] };
  // The API writes its headers capitalised; detach must still find them.
  config.Origins.Items[0].CustomHeaders.Items.push({ HeaderName: "X-Norg-Stale", HeaderValue: "left over" });
  attachGate(config, GATE_OUTPUTS, GATE_OPTIONS);

  detachGate(config, { layout: "gate" });
  const behaviour = config.DefaultCacheBehavior;
  assert.deepEqual(behaviour.FunctionAssociations, { Quantity: 1, Items: [theirs] });
  assert.deepEqual(config.Origins.Items.map((o) => o.Id), ["customer-origin"]);
  assert.deepEqual(config.Origins.Items[0].CustomHeaders, { Quantity: 1, Items: [{ HeaderName: "x-api-key", HeaderValue: "theirs" }] });
  assert.deepEqual(config.CacheBehaviors.Items.map((b) => b.PathPattern), ["/their-thing/*"]);
  assert.equal(JSON.stringify(config).includes("nmt_secret_token"), false, "detaching must take the token with it");
  assert.equal(behaviour.CachePolicyId, "managed-caching-optimized");
  assert.equal(behaviour.OriginRequestPolicyId, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, "restore nothing else: the dry run says the policy is left in place");
});

test("gate: detaching honours --receptionist-origin-id and refuses to remove the default origin", () => {
  const config = distributionConfig();
  attachGate(config, { ...GATE_OUTPUTS, ReceptionistOriginId: "norg-rx" }, GATE_OPTIONS);
  detachGate(config, { layout: "gate", receptionistOriginId: "norg-rx" });
  assert.deepEqual(config.Origins.Items.map((o) => o.Id), ["customer-origin"]);
  assert.throws(() => detachGate(config, { layout: "gate", receptionistOriginId: "customer-origin" }), /is your default origin/);
});

test("gate: argument parsing takes --layout and --origin-headers, keeps '=' inside a value, and rejects an unknown layout", () => {
  const parsed = parseArgs([
    "--layout", "gate", "--distribution-id=E1", "--stack", "s1",
    "--origin-headers=X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=abc=def",
    "--receptionist-origin-id", "norg-rx",
  ]);
  assert.equal(parsed.layout, "gate");
  assert.equal(parsed.originHeaders, "X-Norg-Site-Id=site-1,X-Norg-Mirror-Token=abc=def");
  assert.equal(parsed.receptionistOriginId, "norg-rx");
  assert.deepEqual(parseHeaderPairs(parsed.originHeaders), [
    { HeaderName: "X-Norg-Site-Id", HeaderValue: "site-1" },
    { HeaderName: "X-Norg-Mirror-Token", HeaderValue: "abc=def" },
  ]);
  assert.throws(() => parseArgs(["--layout", "worker"]), /--layout must be one of lambda, gate/);
  assert.throws(() => parseHeaderPairs("X-Norg-Site-Id"), /expected name=value/);
});

test("gate: the Lambda-layout attach is unchanged by the gate code paths", () => {
  // The default layout is still lambda, and its carve-outs still include MCP.
  const config = distributionConfig();
  attach(config, OUTPUTS, OPTIONS);
  assert.ok(config.CacheBehaviors.Items.some((b) => b.PathPattern === "*/mcp"));
  assert.equal(config.Origins.Quantity, 1, "the Lambda layout adds no receptionist origin");
});
