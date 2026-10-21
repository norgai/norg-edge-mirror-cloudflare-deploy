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

  test(`${file}: the router runs at 512 MB (0.6.13), not 192 or 1024`, () => {
    // 0.6.13: CPU scales with memory, and at 192 MB the TLS, signing and JSON
    // work in each NORG call dominated a cold agent request (site key 0.53 s ->
    // 0.17 s at 512 MB, measured on NORG's own install); 1024 MB added only
    // 0.1-0.2 s. Duration falls ~3x so GB-seconds rise ~1.3-1.7x, not 2.7x.
    // Extract the resource block rather than matching within a character
    // window — a window breaks the moment someone adds a comment.
    const block = /^  EdgeRouterFunction:\n((?:    .*\n|\n)*)/m.exec(template);
    assert.ok(block, "no EdgeRouterFunction resource");
    assert.match(block[1], /MemorySize: 512/);
    assert.equal(/MemorySize: (192|1024)/.test(block[1]), false);
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

// ---------------------------------------------------------------------------
// attach-gate.yaml — the no-Lambda layout. It is deliberately NOT in TEMPLATES
// above: those checks pin Lambda, Secrets Manager and heartbeat properties this
// template exists to not have.
// ---------------------------------------------------------------------------

const GATE_TEMPLATE = "attach-gate.yaml";
const GATE_PARAMETERS = [
  "SiteId", "DistributionId", "CustomerOriginId", "ReceptionistHost",
  "ReceptionistOriginId", "NorgEnvironment", "GateVersion", "AlarmTopicArn",
];
const GATE_OUTPUTS = [
  "FunctionArn", "FunctionName", "ReceptionistHost", "ReceptionistOriginId",
  "CustomerOriginId", "GateVersion", "OriginCustomHeaders",
];
// Placeholder -> the parameter Fn::Sub fills it from. Mirrors aws/build.mjs.
const GATE_SUBSTITUTIONS = {
  __RECEPTIONIST_HOST__: "ReceptionistHost",
  __RECEPTIONIST_ORIGIN_ID__: "ReceptionistOriginId",
  __CUSTOMER_ORIGIN_ID__: "CustomerOriginId",
  __GATE_VERSION__: "GateVersion",
};

/**
 * The FunctionCode block scalar's lines, de-indented.
 *
 * @param {string} template Template text.
 * @returns {{lines: Array<string>, code: string}} The embedded code.
 */
function embeddedFunctionCode(template) {
  const block = /      FunctionCode: !Sub \|\n([\s\S]*?)\n      # END GENERATED FUNCTION CODE/.exec(template);
  assert.ok(block, "no generated function-code block");
  const lines = block[1].split("\n");
  for (const line of lines) assert.match(line, /^ {8}\S/, `block scalar line not indented eight spaces: ${JSON.stringify(line.slice(0, 40))}`);
  return { lines, code: lines.map((l) => l.slice(8)).join("\n") };
}

test(`${GATE_TEMPLATE}: has exactly the documented parameters and outputs, with the install values required`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const declared = [...template.matchAll(/^  ([A-Za-z]+):\n(?=    Type: String)/gm)].map((m) => m[1]);
  assert.deepEqual(declared, GATE_PARAMETERS);
  for (const required of ["SiteId", "DistributionId", "CustomerOriginId"]) {
    assert.equal(/^\s+Default:/m.test(parameterBlock(template, required)), false, `${required} must be supplied, never defaulted`);
  }
  const outputs = /^Outputs:\n([\s\S]*)$/m.exec(template)[1];
  assert.deepEqual([...outputs.matchAll(/^  ([A-Za-z]+):\n/gm)].map((m) => m[1]), GATE_OUTPUTS);
});

test(`${GATE_TEMPLATE}: no Lambda, IAM, secret, schedule or S3 artifact — one function and two alarms`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const types = [...template.matchAll(/^    Type: (AWS::[A-Za-z:]+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(types, ["AWS::CloudFront::Function", "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Alarm"]);
  for (const marker of ["AWS::Lambda", "AWS::IAM", "AWS::SecretsManager", "AWS::Events", "ArtifactBucket", "SiteKey", "LambdaFunctionAssociations"]) {
    assert.equal(template.includes(marker), false, `${GATE_TEMPLATE} carries ${marker}`);
  }
});

test(`${GATE_TEMPLATE}: the function is published on every change and runs on the 2.0 runtime`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const fn = /^  EdgeGateFunction:\n((?:    .*\n|\n)*)/m.exec(template);
  assert.ok(fn, "no EdgeGateFunction resource");
  assert.match(fn[1], /AutoPublish: true/, "an unpublished edit leaves the edge on the old code with no error");
  assert.match(fn[1], /Runtime: cloudfront-js-2\.0/, "the origin-modification helpers need runtime 2.0");
  assert.match(fn[1], /Name: !Sub "norg-edge-gate-\$\{SiteId\}"/);
});

test(`${GATE_TEMPLATE}: the inlined code IS aws/src/edge-gate.js with each placeholder swapped for its parameter`, async () => {
  const { GATE_PLACEHOLDERS } = await import("../function/build.mjs");
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const artifact = readFileSync(join(cfnDir, "..", "src", "edge-gate.js"), "utf8").trimEnd();
  const { code } = embeddedFunctionCode(template);

  assert.deepEqual(Object.keys(GATE_SUBSTITUTIONS).sort(), [...GATE_PLACEHOLDERS].sort(), "every placeholder has a parameter");
  let expected = artifact;
  for (const [placeholder, parameter] of Object.entries(GATE_SUBSTITUTIONS)) expected = expected.replaceAll(placeholder, `\${${parameter}}`);
  assert.equal(code, expected, "run: node aws/build.mjs");
  assert.ok(code.startsWith("import cf from 'cloudfront';"));
  // Everything Fn::Sub will touch is one of our five parameters: no stray
  // "${" from the minifier, no "${!" literal escape, no pseudo-parameter.
  const substituted = [...code.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(substituted)].sort(), [...new Set(Object.values(GATE_SUBSTITUTIONS))].sort());
  assert.equal(/__[A-Z_]+__/.test(code), false, "an unsubstituted placeholder would deploy as a literal");
  assert.equal(/catch\s*\{/.test(code), false, "CloudFront's runtime rejects an optional catch binding");
});

test(`${GATE_TEMPLATE}: every parameter inlined into the code cannot break out of its string literal`, () => {
  // The values land inside JavaScript double-quoted strings. A quote mark, a
  // backslash or a newline in a value would end the literal and run as code.
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  for (const parameter of new Set(Object.values(GATE_SUBSTITUTIONS))) {
    const block = parameterBlock(template, parameter);
    const pattern = /AllowedPattern: (\S+)/.exec(block) || /AllowedValues: \[([^\]]+)\]/.exec(block);
    assert.ok(pattern, `${parameter} must constrain its value`);
    if (block.includes("AllowedPattern")) {
      const re = new RegExp(pattern[1]);
      for (const hostile of ['a"b', "a\\b", "a\nb", "a${b}", "a`b"]) {
        assert.equal(re.test(hostile), false, `${parameter} accepts ${JSON.stringify(hostile)}`);
      }
    }
  }
});

test(`${GATE_TEMPLATE}: the substituted function stays under CloudFront's 10 KB limit at the longest allowed values`, async () => {
  const { GATE_SIZE_LIMIT } = await import("../function/build.mjs");
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  const { code } = embeddedFunctionCode(template);
  const longest = {
    ReceptionistHost: `${"a".repeat(63)}.`.repeat(3) + "a".repeat(61), // 253, the DNS maximum
    ReceptionistOriginId: "o".repeat(128),
    CustomerOriginId: "c".repeat(128),
    GateVersion: "v".repeat(32),
  };
  const worst = code.replace(/\$\{([^}]*)\}/g, (_, name) => longest[name]);
  assert.ok(Buffer.byteLength(worst) <= 10_240, `substituted code is ${Buffer.byteLength(worst)} bytes, over CloudFront's limit`);
  assert.ok(Buffer.byteLength(worst) <= GATE_SIZE_LIMIT, `substituted code is ${Buffer.byteLength(worst)} bytes, over the ${GATE_SIZE_LIMIT}-byte gate`);
});

test(`${GATE_TEMPLATE}: the GateVersion default is the version the build stamps`, async () => {
  const { GATE_VERSION } = await import("../function/build.mjs");
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  assert.match(parameterBlock(template, "GateVersion"), new RegExp(`Default: ${GATE_VERSION.replaceAll(".", "\\.")}\\n`));
});

test(`${GATE_TEMPLATE}: both function-error metrics have alarms scoped to the distribution`, () => {
  // CloudFront publishes function metrics per distribution, in us-east-1,
  // under Region=Global. Without all three dimensions the alarm watches nothing.
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  for (const [name, metric] of [["GateExecutionErrorsAlarm", "FunctionExecutionErrors"], ["GateValidationErrorsAlarm", "FunctionValidationErrors"]]) {
    const block = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, "m").exec(template);
    assert.ok(block, `no ${name}`);
    assert.match(block[1], /Namespace: AWS\/CloudFront/);
    assert.match(block[1], new RegExp(`MetricName: ${metric}`));
    assert.match(block[1], /Name: DistributionId\n\s+Value: !Ref DistributionId/);
    assert.match(block[1], /Name: FunctionName\n\s+Value: !Sub "norg-edge-gate-\$\{SiteId\}"/, "the dimension must name the function exactly as the resource does");
    assert.match(block[1], /Name: Region\n\s+Value: Global/);
    assert.match(block[1], /TreatMissingData: notBreaching/);
  }
});

test(`${GATE_TEMPLATE}: the mirror token is not a parameter, not an output, and the Description says so`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  assert.equal(/^  MirrorToken:/m.test(template), false);
  const outputs = /^Outputs:\n([\s\S]*)$/m.exec(template)[1];
  assert.equal(/mirror-token=/i.test(outputs), false, "OriginCustomHeaders must not carry a token slot");
  const description = /^Description: >-\n((?:  .*\n)+)/m.exec(template);
  assert.ok(description, "no Description");
  assert.match(description[1], /X-Norg-Mirror-Token/);
  assert.match(description[1], /X-Norg-Site-Id/);
  assert.ok(description[1].replace(/\s+/g, " ").length <= 1024, "CloudFormation caps Description at 1024 characters");
});

test(`${GATE_TEMPLATE}: no NORG-internal secret name, no credential-shaped literal, under the template-body limit`, () => {
  const template = readFileSync(join(cfnDir, GATE_TEMPLATE), "utf8");
  for (const forbidden of ["CRAWLER_EVENT_SECRET", "WORKER_AUTH_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "INTERNAL_API_KEY", "EDGE_BUCKET"]) {
    assert.equal(template.includes(forbidden), false, `${GATE_TEMPLATE} leaks ${forbidden}`);
  }
  assert.equal(/nek_live_|nmt_/.test(template), false);
  assert.equal(/AKIA[0-9A-Z]{16}/.test(template), false);
  assert.ok(Buffer.byteLength(template) <= 51_200);
});

test(`${GATE_TEMPLATE}: the artifact is digested alongside the Lambda bundles`, async () => {
  const { createHash } = await import("node:crypto");
  const srcDir = join(cfnDir, "..", "src");
  const digests = JSON.parse(readFileSync(join(srcDir, "DIGESTS.json"), "utf8"));
  const { GATE_VERSION } = await import("../function/build.mjs");
  assert.equal(digests.gate_version, GATE_VERSION);
  for (const name of ["edge-router-lambda.cjs", "heartbeat-lambda.cjs", "edge-gate.js"]) {
    const actual = createHash("sha256").update(readFileSync(join(srcDir, name))).digest("hex");
    assert.equal(digests.files[name], actual, `${name} digest is stale — run: node aws/build.mjs`);
  }
});
