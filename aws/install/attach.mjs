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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import {
  CLOUDFRONT_BEHAVIOUR_QUOTA,
  CURATED_ASSET_SUFFIXES,
  DEFAULT_ROUTE_EXCLUSIONS,
  DYNAMIC_ROUTE_EXCLUSIONS,
  MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID,
  MANAGED_CACHING_DISABLED_ID,
  MCP_PATH_PATTERNS,
  PROTECTED_PATH_PREFIXES,
} from "../../core/exclusions.mjs";

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

  const foreignGuard = lambdas.find(
    (item) =>
      item.EventType === "origin-response" &&
      !sameFunction(item.LambdaFunctionARN, outputs.CacheGuardVersionArn),
  );
  if (foreignGuard) {
    throw new Error(
      "this distribution already has an origin-response Lambda@Edge function " +
        `(${foreignGuard.LambdaFunctionARN}).\n` +
        "The cache guard needs that slot. Merge the two functions by hand, or " +
        "attach to a staging distribution instead.",
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
 * Refuse to replace a cache policy whose key carries more than ours does.
 *
 * The stack's policy keys on x-norg-agent, the `agent` query string and the
 * encoding — nothing else. A customer policy that keys on cookies is a session
 * cache; one that keys on other query strings or headers is a per-variant
 * cache. Replacing either collapses those variants into one entry, and
 * CloudFront would then serve one visitor's page to the next. That is not a
 * risk to warn about; it is one to refuse.
 *
 * @param {Object} config The customer's CachePolicyConfig (from get-cache-policy).
 * @returns {void}
 */
function assertReplaceIsSafe(config) {
  const key = config?.ParametersInCacheKeyAndForwardedToOrigin || {};
  const carried = [];
  if ((key.CookiesConfig?.CookieBehavior || "none") !== "none") carried.push("cookies");
  if ((key.HeadersConfig?.HeaderBehavior || "none") !== "none") carried.push("headers");
  if ((key.QueryStringsConfig?.QueryStringBehavior || "none") !== "none") carried.push("query strings");
  if (carried.length === 0) return;
  throw new Error(
    `refusing --cache-policy=replace: your current cache policy keys on ${carried.join(", ")}, ` +
      "and the stack's policy does not. Replacing it would collapse those cache " +
      "variants into one entry and serve one visitor's page to the next.\n\n" +
      "Use --cache-policy=keep and add the `x-norg-agent` header to your own " +
      "policy's cache key instead (copy it first if it is a managed policy).",
  );
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
  // IncludeBody is OFF on the default behaviour on purpose: it is set per
  // association, not per path, and on here it delivers every cache-miss POST
  // body on the site into the router's memory. The MCP transport is the one
  // surface that needs a body, and it gets its own behaviours (below) — the
  // only place IncludeBody is true.
  behaviour.LambdaFunctionAssociations = {
    Quantity: 2,
    Items: [
      {
        EventType: "origin-request",
        LambdaFunctionARN: outputs.EdgeRouterVersionArn,
        IncludeBody: false,
      },
      {
        EventType: "origin-response",
        LambdaFunctionARN: outputs.CacheGuardVersionArn,
        IncludeBody: false,
      },
    ],
  };
  changes.push(`origin-request  -> ${outputs.EdgeRouterVersionArn} (IncludeBody off)`);
  changes.push(`origin-response -> ${outputs.CacheGuardVersionArn} (cache guard)`);

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

  changes.push(...addCarveOuts(config, outputs));
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
  // Nothing secret is injected here any more. The site key used to be written
  // into the distribution at this point, where anyone with
  // cloudfront:GetDistributionConfig could read it; the stack now publishes
  // x-norg-secret-arn instead and the key stays in Secrets Manager.

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

  const keptBehaviours = (config.CacheBehaviors?.Items || []).filter((b) => !isOurs(b, config));
  config.CacheBehaviors = { Quantity: keptBehaviours.length, Items: keptBehaviours };

  for (const origin of config.Origins.Items) {
    const kept = (origin.CustomHeaders?.Items || []).filter(
      (item) => !item.HeaderName.startsWith("x-norg-"),
    );
    origin.CustomHeaders = { Quantity: kept.length, Items: kept };
  }

  return [
    "origin-request  -> removed",
    "origin-response -> removed",
    "viewer-request  -> removed",
    "origin headers  -> x-norg-* removed",
    "carve-outs      -> removed (yours kept)",
    "cache policy    unchanged (change it back yourself if you replaced it)",
  ];
}

const READ_METHODS = { Quantity: 3, Items: ["GET", "HEAD", "OPTIONS"],
  CachedMethods: { Quantity: 3, Items: ["GET", "HEAD", "OPTIONS"] } };
const ALL_METHODS = { Quantity: 7, Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
  CachedMethods: { Quantity: 3, Items: ["GET", "HEAD", "OPTIONS"] } };

/**
 * Refuse a carve-out that would shadow a path NORG serves itself.
 *
 * @param {string} pattern CloudFront path pattern.
 * @returns {void}
 */
function assertDoesNotShadowNorg(pattern) {
  if (pattern.startsWith("*")) return;
  const prefix = pattern.replace(/\*+$/, "");
  const clash = PROTECTED_PATH_PREFIXES.find(
    (p) => p.startsWith(prefix) || prefix.startsWith(p),
  );
  if (clash) {
    throw new Error(
      `carve-out "${pattern}" shadows NORG-served path "${clash}" — ` +
        "CloudFront would stop invoking the router for it",
    );
  }
}

/**
 * The behaviours the router adds, in match order (first match wins).
 *
 *  1. MCP paths — the full router, and the ONLY place IncludeBody is on.
 *  2. Dynamic paths — no Lambda, NO cache (managed CachingDisabled), every
 *     method allowed. A 24 h TTL on /cart would serve one visitor's page to
 *     the next, so these must not share the static policy.
 *  3. Static assets — no Lambda, cached. Framework prefixes before bare
 *     suffixes, since prefix patterns are the more specific.
 *
 * @param {Object} outputs Stack outputs (policy ids and function ARNs).
 * @param {string} targetOriginId Origin the default behaviour points at.
 * @returns {Array<Object>} Behaviour items in match order.
 */
function carveOutBehaviours(outputs, targetOriginId) {
  const base = (PathPattern) => ({
    PathPattern,
    TargetOriginId: targetOriginId,
    ViewerProtocolPolicy: "redirect-to-https",
    Compress: true,
  });
  const mcp = MCP_PATH_PATTERNS.map((pattern) => ({
    ...base(pattern),
    AllowedMethods: ALL_METHODS,
    CachePolicyId: outputs.CachePolicyId,
    OriginRequestPolicyId: outputs.OriginRequestPolicyId,
    FunctionAssociations: {
      Quantity: 1,
      Items: [{ EventType: "viewer-request", FunctionARN: outputs.ViewerClassifierArn }],
    },
    LambdaFunctionAssociations: {
      Quantity: 2,
      Items: [
        { EventType: "origin-request", LambdaFunctionARN: outputs.EdgeRouterVersionArn, IncludeBody: true },
        { EventType: "origin-response", LambdaFunctionARN: outputs.CacheGuardVersionArn, IncludeBody: false },
      ],
    },
  }));
  const dynamic = DYNAMIC_ROUTE_EXCLUSIONS.map((pattern) => {
    assertDoesNotShadowNorg(pattern);
    return {
      ...base(pattern),
      AllowedMethods: ALL_METHODS,
      CachePolicyId: MANAGED_CACHING_DISABLED_ID,
      OriginRequestPolicyId: MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID,
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FunctionAssociations: { Quantity: 0, Items: [] },
    };
  });
  const statics = [
    ...DEFAULT_ROUTE_EXCLUSIONS,
    ...CURATED_ASSET_SUFFIXES.map((suffix) => `*${suffix}`),
  ].map((pattern) => {
    assertDoesNotShadowNorg(pattern);
    return {
      ...base(pattern),
      AllowedMethods: READ_METHODS,
      CachePolicyId: outputs.StaticCachePolicyId,
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FunctionAssociations: { Quantity: 0, Items: [] },
    };
  });
  return [...mcp, ...dynamic, ...statics];
}

/**
 * Is this behaviour one attach() wrote, as opposed to the customer's own?
 *
 * There is no tag field on a cache behaviour, so ours are recognised by shape.
 * Every one of ours points at the default behaviour's origin; a behaviour on a
 * different origin is never ours, which is the case that matters (their API
 * lives there). Beyond that: an MCP behaviour is ours if it runs our router; a
 * dynamic one if it carries the managed CachingDisabled + AllViewer pair with
 * no Lambda; a static one if it has no functions at all. A customer's own
 * function-free `*.css` behaviour on the same origin is indistinguishable and
 * would be treated as ours — a known limit, stated in the README.
 *
 * @param {Object} behaviour A CacheBehaviors item.
 * @param {Object} config Distribution config (for the default origin).
 * @returns {boolean} True when attach() would have written this.
 */
function isOurs(behaviour, config) {
  if (!behaviour) return false;
  const patterns = new Set(carveOutBehaviours({}, "").map((b) => b.PathPattern));
  if (!patterns.has(behaviour.PathPattern)) return false;
  if (behaviour.TargetOriginId !== config.DefaultCacheBehavior.TargetOriginId) return false;

  const lambdas = behaviour.LambdaFunctionAssociations?.Items || [];
  if (MCP_PATH_PATTERNS.includes(behaviour.PathPattern)) {
    return lambdas.some((l) => /EdgeRouter|norg-router/.test(String(l.LambdaFunctionARN)));
  }
  if (lambdas.length || behaviour.FunctionAssociations?.Items?.length) return false;
  if (DYNAMIC_ROUTE_EXCLUSIONS.includes(behaviour.PathPattern)) {
    return (
      behaviour.CachePolicyId === MANAGED_CACHING_DISABLED_ID &&
      behaviour.OriginRequestPolicyId === MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID
    );
  }
  return true;
}

/**
 * Add the carve-outs, refusing rather than exceeding the customer's quota.
 *
 * Their behaviour budget is theirs; silently spending the last of it is the
 * kind of change that surfaces weeks later as "we cannot add a behaviour".
 *
 * @param {Object} config Distribution config, mutated in place.
 * @param {Object} outputs Stack outputs.
 * @returns {Array<string>} Summary lines.
 */
function addCarveOuts(config, outputs) {
  const behaviour = config.DefaultCacheBehavior;
  const existing = config.CacheBehaviors?.Items || [];
  const wanted = carveOutBehaviours(outputs, behaviour.TargetOriginId);

  // A behaviour the customer already has for one of our patterns is THEIRS,
  // and it stays exactly as it is. This matters most for /api/*, which very
  // often points at a different origin: replacing it with ours would repoint
  // their API at their web server. Their behaviour already carries no router,
  // which is all a carve-out is for — except the MCP paths, where the router
  // is the point, so a collision there is refused rather than skipped.
  const theirPatterns = new Set(existing.map((b) => b.PathPattern));
  const mcp = new Set(MCP_PATH_PATTERNS);
  const collidingMcp = wanted.find((b) => mcp.has(b.PathPattern) && theirPatterns.has(b.PathPattern) && !isOurs(existing.find((e) => e.PathPattern === b.PathPattern), config));
  if (collidingMcp) {
    throw new Error(
      `this distribution already has a cache behaviour for "${collidingMcp.PathPattern}", ` +
        "which the MCP transport needs the router on. Remove or rename yours first.",
    );
  }
  const ours = wanted.filter((b) => !theirPatterns.has(b.PathPattern) || isOurs(existing.find((e) => e.PathPattern === b.PathPattern), config));
  const theirs = existing.filter((b) => !isOurs(b, config));
  const skipped = wanted.length - ours.length;

  const total = theirs.length + ours.length + 1; // +1 for the default behaviour
  if (total > CLOUDFRONT_BEHAVIOUR_QUOTA) {
    throw new Error(
      `this distribution has ${theirs.length} cache behaviours; adding ${ours.length} ` +
        `carve-outs would reach ${total}, over CloudFront's limit of ` +
        `${CLOUDFRONT_BEHAVIOUR_QUOTA}.\nRequest a quota increase, or remove some ` +
        "behaviours first — the router works without the carve-outs, they only " +
        "stop it being invoked for static assets.",
    );
  }

  // Ours go FIRST: CloudFront matches in order and the first match wins, so a
  // broad customer behaviour listed above them would swallow the carve-outs.
  const items = [...ours, ...theirs];
  config.CacheBehaviors = { Quantity: items.length, Items: items };
  return [
    `behaviours      +${ours.length} (${MCP_PATH_PATTERNS.length} MCP with the router, ` +
      `${DYNAMIC_ROUTE_EXCLUSIONS.length} dynamic no-cache, the rest static)` +
      (skipped ? `, ${skipped} skipped because you already have them` : "") +
      ` — ${theirs.length} of yours kept, ${total}/${CLOUDFRONT_BEHAVIOUR_QUOTA} used`,
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
  if (options.siteKey || process.env.NORG_SITE_KEY) {
    // Accepted and ignored, so an operator following an older runbook is told
    // why rather than silently installing something that cannot authenticate.
    console.error(
      "note: the site key is no longer passed to this CLI. It lives in Secrets Manager;\n" +
        "      the stack's SiteKey or SecretArn parameter puts it there.",
    );
  }
  delete options.siteKey;

  if (!options.distributionId || !options.stack) {
    throw new Error("--distribution-id and --stack are required");
  }

  const outputs = options.detach ? {} : stackOutputs(options.stack);
  const current = aws(["cloudfront", "get-distribution-config", "--id", options.distributionId]);
  const config = current.DistributionConfig;

  if (!options.detach && options.cachePolicy === "replace") {
    const { CachePolicy } = aws([
      "cloudfront", "get-cache-policy", "--id", config.DefaultCacheBehavior.CachePolicyId,
    ]);
    assertReplaceIsSafe(CachePolicy?.CachePolicyConfig);
  }

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

  // The CLI has to hand the config to `aws` as a file because it exceeds the
  // argv limit. It no longer contains a credential, but it is still the
  // customer's distribution config, so the directory goes away either way.
  const dir = mkdtempSync(join(tmpdir(), "norg-edge-"));
  const file = join(dir, "distribution-config.json");
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nApplied. Watch rollout with:\n  aws cloudfront get-distribution --id ${options.distributionId} --query 'Distribution.Status'`);
}

// Only run when invoked directly, so the pure functions above can be tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  addCarveOuts,
  assertReplaceIsSafe,
  isOurs,
  attach,
  carveOutBehaviours,
  detach,
  parseArgs,
  resolveCachePolicy,
  setOriginHeaders,
};
