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

  test(`${file}: the embedded CloudFront Function matches its source`, () => {
    // build.mjs regenerates this; a hand-edit here would silently ship a
    // different cache-key stamp than the one the tests cover.
    const source = readFileSync(join(cfnDir, "..", "functions", "viewer-classifier.js"), "utf8");
    const embedded = /^ {6}FunctionCode: \|\n((?: {8}.*\n| *\n)*)/m.exec(template);
    assert.ok(embedded, "no inlined FunctionCode block");

    const dedented = embedded[1]
      .split("\n")
      .map((line) => line.replace(/^ {8}/, ""))
      .join("\n")
      .trimEnd();
    assert.equal(dedented, source.trimEnd(), "run: npm run build:aws");
  });
}

test("every generated carve-out has NO Lambda and NO CloudFront function", async () => {
  // A carve-out that kept an association would defeat its entire purpose: the
  // router would still be invoked, and still billed, for every static asset.
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const block = /# BEGIN GENERATED CACHE BEHAVIOURS\n([\s\S]*?)# END GENERATED/.exec(template);
  assert.ok(block, "no generated cache-behaviour block");

  assert.equal(/LambdaFunctionAssociations/.test(block[1]), false);
  assert.equal(/FunctionAssociations/.test(block[1]), false);
  assert.match(block[1], /CachePolicyId: !Ref StaticCachePolicy/);
});

test("the generated carve-outs match the shared suffix list exactly", async () => {
  const { STATIC_ASSET_SUFFIXES } = await import("../../core/constants.mjs");
  const { DEFAULT_ROUTE_EXCLUSIONS } = await import("../../core/exclusions.mjs");
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const block = /# BEGIN GENERATED CACHE BEHAVIOURS\n([\s\S]*?)# END GENERATED/.exec(template)[1];
  const patterns = [...block.matchAll(/PathPattern: "([^"]+)"/g)].map((m) => m[1]);

  const expected = [
    ...DEFAULT_ROUTE_EXCLUSIONS,
    ...[...STATIC_ASSET_SUFFIXES].map((s) => `*${s}`),
  ];
  assert.deepEqual(patterns, expected, "run: npm run build:aws");
});

test("framework exclusions are matched before the bare suffix patterns", () => {
  // CloudFront takes the first match; a prefix carve-out must out-rank the
  // suffix ones so /_next/static/x.css lands on the framework behaviour.
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const block = /# BEGIN GENERATED CACHE BEHAVIOURS\n([\s\S]*?)# END GENERATED/.exec(template)[1];
  const patterns = [...block.matchAll(/PathPattern: "([^"]+)"/g)].map((m) => m[1]);

  const firstSuffix = patterns.findIndex((p) => p.startsWith("*"));
  const lastPrefix = patterns.map((p) => !p.startsWith("*")).lastIndexOf(true);
  assert.ok(lastPrefix < firstSuffix, "a prefix carve-out is listed after a suffix one");
});

test("the carve-out cache policy does not split the cache by agent", () => {
  // These bytes are identical for every caller; keying on x-norg-agent would
  // double the entries for nothing.
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  const policy = /StaticCachePolicy:[\s\S]*?CookieBehavior: none/.exec(template);
  assert.ok(policy, "no StaticCachePolicy");
  assert.equal(/x-norg-agent/.test(policy[0]), false);
  assert.match(policy[0], /HeaderBehavior: none/);
});

test("the origin-request association includes the request body", () => {
  // The MCP JSON-RPC transport is a POST the router forwards to NORG.
  const template = readFileSync(join(cfnDir, "new-distribution.yaml"), "utf8");
  assert.match(template, /IncludeBody: true/);
});
