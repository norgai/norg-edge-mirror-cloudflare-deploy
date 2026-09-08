/**
 * Guards on the CloudFormation templates.
 *
 * @description Pins the supply-chain properties of the install templates.
 *
 * These templates install code into a CUSTOMER's AWS account and attach it to
 * their whole site with an IAM role. This repository is public, so anything the
 * templates resolve by name is a name an attacker can read — and, in S3's case,
 * potentially register. The checks here are about that, not about YAML syntax.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cfnDir = join(dirname(fileURLToPath(import.meta.url)), "..", "cloudformation");
const TEMPLATES = ["new-distribution.yaml", "attach-existing.yaml"];

/**
 * Extract one parameter's YAML block from a template.
 *
 * @param {string} template Template source.
 * @param {string} name Parameter name.
 * @returns {string} The block's body, excluding the name line.
 */
function parameterBlock(template, name) {
  const match = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, "m").exec(template);
  assert.ok(match, `parameter ${name} not found`);
  return match[1];
}

for (const file of TEMPLATES) {
  const template = readFileSync(join(cfnDir, file), "utf8");

  test(`${file}: no code-source parameter has a default`, () => {
    // S3 bucket names are globally unique across all AWS accounts. A default
    // naming a bucket NORG has not created could be REGISTERED by anyone
    // reading this public repo, and every stack launched from the template
    // would then install their code as a Lambda@Edge function in front of the
    // customer's whole site. Requiring the value is what closes that.
    for (const parameter of ["ArtifactBucket", "ArtifactKey", "HeartbeatArtifactKey"]) {
      assert.equal(
        /^\s+Default:/m.test(parameterBlock(template, parameter)),
        false,
        `${parameter} must not default — an unowned S3 name is a supply-chain hole`,
      );
    }
  });

  test(`${file}: the code source can be pinned to an S3 object version`, () => {
    assert.match(template, /S3ObjectVersion: !If \[HasArtifactObjectVersion/);
    assert.match(template, /S3ObjectVersion: !If \[HasHeartbeatObjectVersion/);
  });

  test(`${file}: a new artifact forces a new published Lambda version`, () => {
    // AWS::Lambda::Version publishes only when its own properties change, and
    // FunctionName does not change when the code does. Without something
    // artifact-derived here, a router update lands on $LATEST while the
    // distribution stays pinned to the first version it ever published — the
    // deploy reports success and the edge keeps running the old code.
    assert.match(
      template,
      /EdgeRouterVersion:[\s\S]{0,400}?Description: !Sub "\$\{ArtifactKey\}@\$\{ArtifactObjectVersion\}"/,
      "EdgeRouterVersion needs an artifact-derived Description to force republication",
    );
  });

  test(`${file}: the router runs at 192 MB, not the original 512`, () => {
    // Measured peak was 116 MB across 91 live invocations. Lambda@Edge bills
    // GB-seconds with no free tier, so provisioning is a direct cost multiplier.
    // Extract the resource block rather than matching within a character
    // window — a window breaks the moment someone adds a comment.
    const block = /^  EdgeRouterFunction:\n((?:    .*\n|\n)*)/m.exec(template);
    assert.ok(block, "no EdgeRouterFunction resource");
    assert.match(block[1], /MemorySize: 192/);
    assert.equal(/MemorySize: 512/.test(block[1]), false);
  });

  test(`${file}: the Lambda@Edge role trusts both required principals`, () => {
    // edgelambda.amazonaws.com is what replicates the function to the edge;
    // without it the association fails at deploy with an opaque error.
    assert.match(template, /Service: \[lambda\.amazonaws\.com, edgelambda\.amazonaws\.com\]/);
  });

  test(`${file}: the site key is a NoEcho parameter`, () => {
    assert.match(parameterBlock(template, "SiteKey"), /NoEcho: true/);
  });

  test(`${file}: no NORG-internal secret name appears`, () => {
    for (const forbidden of [
      "CRAWLER_EVENT_SECRET",
      "WORKER_AUTH_SECRET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "INTERNAL_API_KEY",
      "EDGE_BUCKET",
    ]) {
      assert.equal(template.includes(forbidden), false, `${file} leaks ${forbidden}`);
    }
  });

  test(`${file}: no credential-shaped literal is baked in`, () => {
    assert.equal(/nek_live_/.test(template), false);
    assert.equal(/AKIA[0-9A-Z]{16}/.test(template), false);
  });

  test(`${file}: cache-key properties use CloudFormation's list shape`, () => {
    // CloudFront's *API* takes {Quantity, Items: [...]} here; CloudFormation's
    // resource schema takes a plain list and rejects the API shape with
    // "expected type: JSONArray, found: JSONObject". The two shapes are easy to
    // confuse, `validate-template` does not catch it (it checks syntax, not
    // resource schemas), and the failure only appears at deploy time — which is
    // exactly how it reached a real stack once.
    for (const property of ["Headers", "QueryStrings"]) {
      const withItems = new RegExp(`${property}:\\s*\\n\\s+Items:`);
      assert.equal(
        withItems.test(template),
        false,
        `${property} uses the API's {Items: [...]} shape; CloudFormation wants a plain list`,
      );
    }
  });

  test(`${file}: no cache-partition artifact survives`, () => {
    // 0.6.0 does not cache the human page at the edge, so the viewer-request
    // stamp, the custom cache policy keyed on it and the origin-response guard
    // are gone. Any of them coming back means a cache key to get wrong again.
    for (const marker of ["ViewerClassifier", "CacheGuard", "x-norg-agent", "AWS::CloudFront::Function", "origin-response"]) {
      assert.equal(template.includes(marker), false, `${file} still carries ${marker}`);
    }
  });

  test(`${file}: the site key is replicated to every other Lambda@Edge region, behind a parameter`, () => {
    assert.match(parameterBlock(template, "ReplicateSecret"), /Default: "true"/);
    const secret = /^  SiteKeySecret:\n((?:    .*\n|\n)*)/m.exec(template);
    assert.ok(secret, "no SiteKeySecret resource");
    assert.match(secret[1], /ReplicaRegions: !If\n\s+- ReplicateSecret/);
    const regions = [...secret[1].matchAll(/- Region: ([a-z0-9-]+)/g)].map((m) => m[1]);
    assert.equal(regions.length, 12, "twelve replicas plus the us-east-1 primary make the thirteen edge regions");
    assert.equal(regions.includes("us-east-1"), false, "the primary is not its own replica");
  });

  test(`${file}: the read policy allows the same secret in any region, and only that secret`, () => {
    // A replica's ARN differs from the primary's only in the region segment.
    // The role must reach it, and must still not be a way to read anything
    // else: wildcard the REGION, never the name.
    const policies = [...template.matchAll(/PolicyName: ReadSiteKey[\s\S]*?Resource: !Join\n([\s\S]*?)\n\n/g)];
    assert.ok(policies.length >= 2, "both execution roles read the key");
    for (const [, body] of policies) {
      assert.match(body, /- secretsmanager\n\s+- "\*"\n/, "the region segment is the wildcard");
      assert.match(body, /!Select \[6, !Split \[":"/, "the name segment comes from the ARN itself");
      assert.equal(/secret:\*|secret\/\*/.test(body), false, "never a wildcard on the name");
    }
  });

  test(`${file}: the kill switch is a parameter wired to the x-norg-disabled header`, () => {
    assert.match(parameterBlock(template, "EdgeDisabled"), /AllowedValues: \["true", "false"\]/);
    assert.match(template, /x-norg-disabled/);
  });

  test(`${file}: router and heartbeat errors have alarms`, () => {
    assert.match(template, /RouterErrorsAlarm:/);
    assert.match(template, /HeartbeatErrorsAlarm:/);
    // Lambda@Edge metrics are published under the replicated name.
    assert.match(template, /Value: !Sub "us-east-1\.\$\{EdgeRouterFunction\}"/);
  });
}

/**
 * Split the generated block into one YAML chunk per behaviour.
 *
 * @param {string} template Template text.
 * @returns {Array<{pattern: string, body: string}>} Behaviours in order.
 */
function generatedBehaviours(template) {
  const block = /# BEGIN GENERATED CACHE BEHAVIOURS\n([\s\S]*?)# END GENERATED/.exec(template);
  assert.ok(block, "no generated cache-behaviour block");
  return block[1]
    .split(/\n(?= {10}- PathPattern:)/)
    .filter((chunk) => chunk.trim())
    .map((body) => ({ pattern: /PathPattern: "([^"]+)"/.exec(body)[1], body }));
}

test("the generated behaviours match the shared lists, in match order", async () => {
  const { STATIC_ASSET_SUFFIXES } = await import("../../core/constants.mjs");
  const { DEFAULT_ROUTE_EXCLUSIONS, DYNAMIC_ROUTE_EXCLUSIONS, MCP_PATH_PATTERNS, TEMPLATE_ASSET_SUFFIXES } =
    await import("../../core/exclusions.mjs");
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const patterns = generatedBehaviours(template).map((b) => b.pattern);

  // First match wins, so each group must be more specific than the next.
  const expected = [
    ...MCP_PATH_PATTERNS,
    ...DYNAMIC_ROUTE_EXCLUSIONS,
    ...DEFAULT_ROUTE_EXCLUSIONS,
    ...TEMPLATE_ASSET_SUFFIXES.map((s) => `*${s}`),
  ];
  assert.deepEqual(patterns, expected, "run: npm run build:aws");
  // A suffix the template carves out but the router does not recognise would
  // be cached by CloudFront and yet mirrored on a miss — never allowed.
  for (const suffix of TEMPLATE_ASSET_SUFFIXES) {
    assert.ok(STATIC_ASSET_SUFFIXES.has(suffix), `${suffix} is not in STATIC_ASSET_SUFFIXES`);
  }
});

test("the template body stays under CloudFormation's 51,200-byte limit", () => {
  // validate-template, create-stack and the console all refuse a larger body;
  // only an S3 template URL goes higher, and the README's install command does
  // not use one.
  for (const file of ["new-distribution.yaml", "attach-existing.yaml"]) {
    const bytes = readFileSync(join(cfnDir, file)).byteLength;
    assert.ok(bytes <= 51_200, `${file} is ${bytes} bytes; trim TEMPLATE_ASSET_SUFFIXES`);
  }
});

test("the MCP behaviours are the ONLY place the request body is included", async () => {
  // IncludeBody is per association. On the default behaviour it delivered
  // every cache-miss POST body on the site into the router; only the MCP
  // JSON-RPC transport actually needs one.
  const { MCP_PATH_PATTERNS } = await import("../../core/exclusions.mjs");
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const mcp = new Set(MCP_PATH_PATTERNS);

  for (const { pattern, body } of generatedBehaviours(template)) {
    if (mcp.has(pattern)) {
      assert.match(body, /IncludeBody: true/, `${pattern} must carry the body`);
      assert.match(body, /LambdaFunctionARN: !Ref EdgeRouterVersion/, `${pattern} must run the router`);
      assert.equal((body.match(/EventType:/g) || []).length, 1, `${pattern} runs only the router`);
      assert.match(body, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/, `${pattern} is never cached`);
    } else {
      assert.equal(/LambdaFunctionAssociations/.test(body), false, `${pattern} must have no Lambda`);
      assert.equal(/FunctionAssociations/.test(body), false, `${pattern} must have no function`);
    }
  }
  assert.equal((template.match(/IncludeBody: true/g) || []).length, MCP_PATH_PATTERNS.length);
});

test("dynamic carve-outs are never cached; static ones are", async () => {
  // A 24 h default TTL on /cart would serve one visitor's page to the next.
  const { DYNAMIC_ROUTE_EXCLUSIONS, MANAGED_CACHING_DISABLED_ID, MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID, MCP_PATH_PATTERNS } =
    await import("../../core/exclusions.mjs");
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const dynamic = new Set(DYNAMIC_ROUTE_EXCLUSIONS);

  for (const { pattern, body } of generatedBehaviours(template)) {
    if (dynamic.has(pattern)) {
      assert.match(body, new RegExp(`CachePolicyId: ${MANAGED_CACHING_DISABLED_ID}`), pattern);
      assert.match(body, new RegExp(`OriginRequestPolicyId: ${MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID}`), pattern);
      assert.match(body, /AllowedMethods: \[GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE\]/, `${pattern} takes POSTs`);
    } else if (!MCP_PATH_PATTERNS.includes(pattern)) {
      assert.match(body, /CachePolicyId: !Ref StaticCachePolicy/, pattern);
    }
  }
});

test("prefix carve-outs are matched before the bare suffix patterns", () => {
  // CloudFront takes the first match; a prefix carve-out must out-rank the
  // suffix ones so /_next/static/x.css lands on the framework behaviour.
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const patterns = generatedBehaviours(template).map((b) => b.pattern);

  const firstSuffix = patterns.findIndex((p) => p.startsWith("*."));
  const lastPrefix = patterns.map((p) => !p.startsWith("*.")).lastIndexOf(true);
  assert.ok(lastPrefix < firstSuffix, "a prefix carve-out is listed after a suffix one");
});

test("the behaviour count stays under CloudFront's quota with room for the customer", () => {
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const count = generatedBehaviours(template).length + 1;
  assert.ok(count <= 65, `${count} behaviours leaves fewer than 10 of 75 for the customer`);
});

test("the asset carve-out policy is the only caching the distribution does", () => {
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const policy = /StaticCachePolicy:[\s\S]*?CookieBehavior: none/.exec(template);
  assert.ok(policy, "no StaticCachePolicy");
  assert.match(policy[0], /HeaderBehavior: none/);
  assert.equal((template.match(/AWS::CloudFront::CachePolicy/g) || []).length, 1, "one cache policy: assets");
});

test("the default behaviour is never cached and runs only the router, body OFF", () => {
  // The human page is not cached at the edge: every page request reaches the
  // router and the origin answers it. There is no cache key to get wrong.
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const dflt = /DefaultCacheBehavior:[\s\S]*?HeartbeatRole:/.exec(template)[0];
  assert.match(dflt, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/, "managed CachingDisabled");
  assert.match(dflt, /EventType: origin-request[\s\S]*?IncludeBody: false/);
  assert.equal((dflt.match(/EventType:/g) || []).length, 1, "one association: the router");
  assert.equal(/\n\s+FunctionAssociations:/.test(dflt), false, "no CloudFront Function on the default behaviour");
});

test("rate limiting is on by default, and can be switched off", () => {
  // Every page request is an invocation against the regional concurrency
  // quota, and past it CloudFront answers a 503. A customer who already runs
  // WAF turns it off and adds the rule to their own ACL.
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  assert.match(parameterBlock(template, "EnableRateLimit"), /Default: "true"/);
  assert.match(parameterBlock(template, "EnableRateLimit"), /AllowedValues: \["true", "false"\]/);
  assert.match(template, /RateLimitWebAcl:\n\s+Type: AWS::WAFv2::WebACL\n\s+Condition: RateLimitEnabled/);
  assert.match(template, /WebACLId: !If \[RateLimitEnabled/);
});
