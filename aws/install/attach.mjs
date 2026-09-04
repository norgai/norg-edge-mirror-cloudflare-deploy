/**
 * Attach (or detach) the NORG edge router on an EXISTING CloudFront distribution.
 *
 * Usage:
 *   node aws/install/attach.mjs --distribution-id E123 --stack norg-edge [--apply]
 *   node aws/install/attach.mjs --distribution-id E123 --stack norg-edge --detach --apply
 *
 * CloudFormation cannot modify a distribution it does not own, so this is the
 * second step after deploying aws/cloudformation/attach-existing.yaml. It reads
 * that stack's outputs, rewrites your live distribution's default cache
 * behaviour, and writes it back with the config's own ETag so a concurrent
 * change fails loudly instead of being clobbered.
 *
 * IT IS A DRY RUN UNLESS YOU PASS --apply. It prints exactly what would change
 * and exits.
 *
 * Two behaviours are deliberate and worth knowing before you read the code:
 *
 *  - It REFUSES rather than works around a conflict. An existing origin-request
 *    Lambda@Edge association, or an existing viewer-request function, is
 *    someone else's routing decision; silently replacing it is how an install
 *    breaks a site in a way nobody can attribute. This mirrors how the
 *    Cloudflare installer refuses an overlapping worker route.
 *  - It will not silently change your caching. The router needs `x-norg-agent`
 *    in the cache key or agents get served humans' cached pages, but your cache
 *    policy is tuned to your application and may be shared with other
 *    distributions. So the choice is yours to state with --cache-policy, and
 *    there is no default that guesses.
 *
 * Shells out to the AWS CLI rather than taking an SDK dependency: this repo's
 * build and tests are zero-install, and anyone attaching a distribution already
 * has the CLI configured.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const REGION = "us-east-1";

/**
 * Parse argv into an options object.
 *
 * @param {Array<string>} argv Raw arguments.
 * @returns {Object} Parsed options.
 */
function parseArgs(argv) {
  const options = { apply: false, detach: false, cachePolicy: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=");
    const next = () => inline ?? argv[++i];
    if (flag === "--distribution-id") options.distributionId = next();
    else if (flag === "--stack") options.stack = next();
    else if (flag === "--site-key") options.siteKey = next();
    else if (flag === "--cache-policy") options.cachePolicy = next();
    else if (flag === "--apply") options.apply = true;
    else if (flag === "--detach") options.detach = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

/**
 * Run an AWS CLI command and parse its JSON output.
 *
 * @param {Array<string>} args CLI arguments after `aws`.
 * @returns {Object} Parsed response.
 */
function aws(args) {
  const output = execFileSync("aws", [...args, "--region", REGION, "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return output.trim() ? JSON.parse(output) : {};
}

/**
 * Read the attach-existing stack's outputs.
 *
 * @param {string} stack Stack name.
 * @returns {Object} Outputs keyed by output name.
 */
function stackOutputs(stack) {
  const { Stacks } = aws(["cloudformation", "describe-stacks", "--stack-name", stack]);
  const outputs = {};
  for (const output of Stacks[0].Outputs || []) outputs[output.OutputKey] = output.OutputValue;
  return outputs;
}

/**
 * Is this ARN the same Lambda function, ignoring the version suffix?
 *
 * A published version ARN ends in ":7"; the same function at a different
 * version is still the same function, which is what makes re-attaching after a
 * router upgrade or a key rotation distinguishable from a stranger's install.
 *
 * @param {string} a First function ARN.
 * @param {string} b Second function ARN.
 * @returns {boolean} True when both name the same function.
 */
function sameFunction(a, b) {
  const unversioned = (arn) => String(arn).replace(/:\d+$/, "");
  return Boolean(a && b) && unversioned(a) === unversioned(b);
}

/**
 * Refuse to proceed when someone else already owns this distribution's routing.
 *
 * OUR OWN association is not a conflict. Re-attaching is the normal way to move
 * to a new router version or a rotated site key, and refusing it would make
 * every upgrade a manual detach-then-attach against a live distribution.
 *
 * @param {Object} behaviour The default cache behaviour.
 * @param {Object} outputs Stack outputs identifying our own functions.
 * @returns {void}
 */
function assertNoConflict(behaviour, outputs) {
  const lambdas = behaviour.LambdaFunctionAssociations?.Items || [];
  const conflicting = lambdas.find(
    (item) =>
      item.EventType === "origin-request" &&
      !sameFunction(item.LambdaFunctionARN, outputs.EdgeRouterVersionArn),
  );
  if (conflicting) {
    throw new Error(
      "this distribution already has an origin-request Lambda@Edge function " +
        `(${conflicting.LambdaFunctionARN}).\n` +
        "Replacing it would silently take over someone else's routing. Remove it " +
        "first, or attach to a staging distribution instead.",
    );
  }

  const functions = behaviour.FunctionAssociations?.Items || [];
  const conflictingFunction = functions.find(
    (item) =>
      item.EventType === "viewer-request" && item.FunctionARN !== outputs.ViewerClassifierArn,
  );
  if (conflictingFunction) {
    throw new Error(
      "this distribution already has a viewer-request CloudFront Function " +
        `(${conflictingFunction.FunctionARN}).\n` +
        "The router needs that slot to stamp the cache key. Merge the two " +
        "functions by hand, or attach to a staging distribution instead.",
    );
  }
}

/**
 * Decide what to do about the cache key, or refuse until told.
 *
 * @param {Object} behaviour The default cache behaviour.
 * @param {Object} options Parsed CLI options.
 * @param {Object} outputs Stack outputs.
 * @returns {?string} Cache policy id to set, or null to leave it alone.
 */
function resolveCachePolicy(behaviour, options, outputs) {
  if (options.cachePolicy === "keep") return null;
  if (options.cachePolicy === "replace") return outputs.CachePolicyId;

  throw new Error(
    "the router needs `x-norg-agent` in this behaviour's cache key. Without it, a " +
      "page warmed by a human is served from cache to the next AI agent and the " +
      "router never runs — the install looks fine and does nothing.\n\n" +
      `This behaviour currently uses cache policy ${behaviour.CachePolicyId}.\n\n` +
      "Choose explicitly:\n" +
      "  --cache-policy=replace  use the stack's policy (DefaultTTL 0, honours your\n" +
      "                          origin's Cache-Control; review it first)\n" +
      "  --cache-policy=keep     keep yours — then add the `x-norg-agent` header to\n" +
      "                          its cache key yourself. A CloudFront MANAGED policy\n" +
      "                          cannot be edited, so 'keep' means copying it first.",
  );
}

/**
 * Apply the router to a distribution config, in place.
 *
 * @param {Object} config Distribution config.
 * @param {Object} outputs Stack outputs.
 * @param {Object} options Parsed CLI options.
 * @returns {Array<string>} Human-readable summary of the changes.
 */
function attach(config, outputs, options) {
  const behaviour = config.DefaultCacheBehavior;
  assertNoConflict(behaviour, outputs);

  const changes = [];
  // IncludeBody is required, not optional: the MCP JSON-RPC transport is a POST
  // whose body the router forwards to NORG, and without this CloudFront hands
  // the function an empty body. Read-only access, so CloudFront still sends the
  // full original body to your origin.
  behaviour.LambdaFunctionAssociations = {
    Quantity: 1,
    Items: [
      {
        EventType: "origin-request",
        LambdaFunctionARN: outputs.EdgeRouterVersionArn,
        IncludeBody: true,
      },
    ],
  };
  changes.push(`origin-request  -> ${outputs.EdgeRouterVersionArn}`);

  behaviour.FunctionAssociations = {
    Quantity: 1,
    Items: [{ EventType: "viewer-request", FunctionARN: outputs.ViewerClassifierArn }],
  };
  changes.push(`viewer-request  -> ${outputs.ViewerClassifierArn}`);

  const cachePolicyId = resolveCachePolicy(behaviour, options, outputs);
  if (cachePolicyId) {
    changes.push(`cache policy    ${behaviour.CachePolicyId} -> ${cachePolicyId}`);
    behaviour.CachePolicyId = cachePolicyId;
  } else {
    changes.push("cache policy    unchanged (you are adding x-norg-agent to it yourself)");
  }

  behaviour.OriginRequestPolicyId = outputs.OriginRequestPolicyId;
  changes.push(`origin request  -> ${outputs.OriginRequestPolicyId}`);

  const origin = config.Origins.Items.find((item) => item.Id === behaviour.TargetOriginId);
  if (!origin) throw new Error(`no origin matches the default behaviour's TargetOriginId`);
  setOriginHeaders(origin, outputs, options);
  changes.push(`origin headers  -> ${origin.Id} (install config, incl. the site key)`);

  return changes;
}

/**
 * Write the NORG install config onto an origin as custom headers.
 *
 * This is how config reaches the router: Lambda@Edge supports no environment
 * variables. The router deletes these before the request continues to your
 * server, so the key never reaches your own access logs.
 *
 * @param {Object} origin Origin config, mutated in place.
 * @param {Object} outputs Stack outputs.
 * @param {Object} options Parsed CLI options.
 * @returns {void}
 */
function setOriginHeaders(origin, outputs, options) {
  const declared = Object.fromEntries(
    outputs.OriginCustomHeaders.split(",").map((pair) => {
      const [name, ...rest] = pair.trim().split("=");
      return [name, rest.join("=")];
    }),
  );
  declared["x-norg-site-key"] = options.siteKey;

  const existing = (origin.CustomHeaders?.Items || []).filter(
    (item) => !item.HeaderName.startsWith("x-norg-"),
  );
  const items = [
    ...existing,
    ...Object.entries(declared).map(([HeaderName, HeaderValue]) => ({ HeaderName, HeaderValue })),
  ];
  origin.CustomHeaders = { Quantity: items.length, Items: items };
}

/**
 * Remove the router from a distribution config, in place.
 *
 * @param {Object} config Distribution config.
 * @returns {Array<string>} Human-readable summary of the changes.
 */
function detach(config) {
  const behaviour = config.DefaultCacheBehavior;
  behaviour.LambdaFunctionAssociations = { Quantity: 0, Items: [] };
  behaviour.FunctionAssociations = { Quantity: 0, Items: [] };

  for (const origin of config.Origins.Items) {
    const kept = (origin.CustomHeaders?.Items || []).filter(
      (item) => !item.HeaderName.startsWith("x-norg-"),
    );
    origin.CustomHeaders = { Quantity: kept.length, Items: kept };
  }

  return [
    "origin-request  -> removed",
    "viewer-request  -> removed",
    "origin headers  -> x-norg-* removed",
    "cache policy    unchanged (change it back yourself if you replaced it)",
  ];
}

/**
 * Ask the operator to confirm before touching a live distribution.
 *
 * @param {string} distributionId Distribution being changed.
 * @returns {Promise<boolean>} True when the operator typed yes.
 */
async function confirm(distributionId) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nApply this to ${distributionId}? (yes/no) `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when the command completes.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.siteKey = options.siteKey || process.env.NORG_SITE_KEY;

  if (!options.distributionId || !options.stack) {
    throw new Error("--distribution-id and --stack are required");
  }
  // describe-stacks masks NoEcho parameters, so the key cannot be read back
  // from the stack and has to be supplied here.
  if (!options.detach && !options.siteKey) {
    throw new Error("--site-key (or NORG_SITE_KEY) is required: the stack masks it as NoEcho");
  }

  const outputs = options.detach ? {} : stackOutputs(options.stack);
  const current = aws(["cloudfront", "get-distribution-config", "--id", options.distributionId]);
  const config = current.DistributionConfig;

  const changes = options.detach ? detach(config) : attach(config, outputs, options);

  console.log(`\nDistribution ${options.distributionId} (${config.Comment || "no comment"})`);
  console.log("Default cache behaviour changes:\n");
  for (const change of changes) console.log(`  ${change}`);

  if (!options.apply) {
    console.log("\nDry run. Re-run with --apply to make these changes.");
    return;
  }

  console.log(
    "\nA distribution update takes 5-15 minutes to propagate, and a Lambda@Edge\n" +
      "replica can take ~30 minutes before it can be deleted. Reverting is slow.",
  );
  if (!(await confirm(options.distributionId))) {
    console.log("Aborted. Nothing was changed.");
    return;
  }

  const file = join(mkdtempSync(join(tmpdir(), "norg-edge-")), "distribution-config.json");
  writeFileSync(file, JSON.stringify(config));

  // --if-match with the config's own ETag: a concurrent change fails loudly
  // rather than being silently overwritten.
  aws([
    "cloudfront",
    "update-distribution",
    "--id",
    options.distributionId,
    "--if-match",
    current.ETag,
    "--distribution-config",
    `file://${file}`,
  ]);

  console.log(`\nApplied. Watch rollout with:\n  aws cloudfront get-distribution --id ${options.distributionId} --query 'Distribution.Status'`);
}

// Only run when invoked directly, so the pure functions above can be tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  });
}

export { attach, detach, parseArgs, resolveCachePolicy, setOriginHeaders };
