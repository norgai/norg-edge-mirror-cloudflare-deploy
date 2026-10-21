/**
 * Attach (or detach) the NORG edge router on an EXISTING CloudFront distribution.
 *
 * Usage:
 *   node aws/install/attach.mjs --distribution-id E123 --stack norg-edge [--apply]
 *   node aws/install/attach.mjs --distribution-id E123 --stack norg-edge --detach --apply
 *   node aws/install/attach.mjs --layout gate --distribution-id E123 --stack norg-gate \
 *        --origin-headers "X-Norg-Site-Id=<id>,X-Norg-Mirror-Token=<token>" [--apply]
 *   node aws/install/attach.mjs --layout gate --distribution-id E123 --detach --apply
 *
 * CloudFormation cannot modify a distribution it does not own, so this is the
 * second step after deploying aws/cloudformation/attach-existing.yaml (the
 * Lambda layout, the default) or aws/cloudformation/attach-gate.yaml
 * (--layout gate: one CloudFront Function, no Lambda). It reads that stack's
 * outputs, rewrites your live distribution's default cache behaviour, and
 * writes it back with the config's own ETag so a concurrent change fails
 * loudly instead of being clobbered.
 *
 * The gate layout changes less. It adds NORG's receptionist as an origin, puts
 * the function on viewer-request, forwards all viewer headers but Host, and
 * adds the dynamic carve-outs. It leaves your cache policy alone — humans never
 * reach NORG code, so there is no reason to stop caching your HTML — and it
 * writes nothing onto your own origin. The mirror token the receptionist
 * authenticates with is a secret, so it is not a stack parameter: pass it in
 * --origin-headers, or let NORG's API (which does the same edit) inject it.
 *
 * IT IS A DRY RUN UNLESS YOU PASS --apply. It prints exactly what would change
 * and exits.
 *
 * Two behaviours are deliberate and worth knowing before you read the code:
 *
 *  - It REFUSES rather than works around a conflict. An existing origin-request
 *    Lambda@Edge association is someone else's routing decision; silently
 *    replacing it is how an install breaks a site in a way nobody can
 *    attribute. This mirrors how the Cloudflare installer refuses an
 *    overlapping worker route.
 *  - It stops CloudFront caching your HTML. The default behaviour's cache
 *    policy becomes the managed CachingDisabled policy, so every page request
 *    reaches the router and your origin answers it. That is stated in the dry
 *    run, in those words, before you confirm. Asset carve-outs stay cached.
 *  - It reads your Lambda concurrency quota in every region Lambda@Edge runs
 *    in and warns when one is low, because that quota is the one limit that
 *    answers a visitor with a 503. It never refuses on it.
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

// Where Lambda@Edge executes. The router's concurrency in each of these is
// bounded by that region's Lambda quota, shared with every other Lambda the
// account runs there.
const EDGE_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2",
  "eu-central-1", "eu-west-1", "eu-west-2", "sa-east-1",
];
const LAMBDA_CONCURRENCY_QUOTA_CODE = "L-B99A9384";
// Each Lambda@Edge instance serves 10 requests per second, so the regional
// page-request ceiling is ten times the quota. Below this the warning fires.
const LOW_CONCURRENCY_QUOTA = 100;

const LAYOUTS = ["lambda", "gate"];
// Default Id of the receptionist origin in the gate layout; the stack's
// ReceptionistOriginId output overrides it on attach, --receptionist-origin-id
// on detach (when the stack may already be gone).
const DEFAULT_RECEPTIONIST_ORIGIN_ID = "norg-receptionist";
// Our own viewer-request functions, by name: the gate itself and the 0.5.x
// cache-bucket classifier an old install may have left behind. Either is
// replaced on attach and removed on detach; anything else is someone else's.
const OUR_FUNCTION_ARN = /norg-edge-gate|norg-viewer-classifier/;
// Our own Lambda@Edge router, by name, when there is no stack output to compare
// against (the gate stack has none). Matches the attach-existing stack's
// EdgeRouterFunction physical name and the pre-stack manual installs.
const OUR_LAMBDA_ARN = /EdgeRouter|norg-router/;
const MIRROR_TOKEN_HEADER = "x-norg-mirror-token";

/**
 * Parse argv into an options object.
 *
 * @param {Array<string>} argv Raw arguments.
 * @returns {Object} Parsed options.
 */
function parseArgs(argv) {
  const options = { apply: false, detach: false, layout: "lambda" };
  for (let i = 0; i < argv.length; i += 1) {
    // Split on the FIRST "=" only: an --origin-headers value is itself a list
    // of name=value pairs.
    const eq = argv[i].indexOf("=");
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq === -1 ? undefined : argv[i].slice(eq + 1);
    const next = () => inline ?? argv[++i];
    if (flag === "--distribution-id") options.distributionId = next();
    else if (flag === "--stack") options.stack = next();
    else if (flag === "--site-key") options.siteKey = next();
    else if (flag === "--layout") options.layout = next();
    else if (flag === "--origin-headers") options.originHeaders = next();
    else if (flag === "--receptionist-origin-id") options.receptionistOriginId = next();
    else if (flag === "--apply") options.apply = true;
    else if (flag === "--detach") options.detach = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!LAYOUTS.includes(options.layout)) {
    throw new Error(`--layout must be one of ${LAYOUTS.join(", ")}, not "${options.layout}"`);
  }
  return options;
}

/**
 * Run an AWS CLI command and parse its JSON output.
 *
 * @param {Array<string>} args CLI arguments after `aws`.
 * @param {string} region Region to run it in.
 * @returns {Object} Parsed response.
 */
function aws(args, region = REGION) {
  const output = execFileSync("aws", [...args, "--region", region, "--output", "json"], {
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
}

/**
 * The Lambda concurrency quota in every region Lambda@Edge runs in.
 *
 * Read, never enforced: the operator decides. A region that cannot be read
 * (no permission, no CLI access) reports null rather than failing the attach.
 *
 * @returns {Array<{region: string, value: ?number}>} One entry per region.
 */
function lambdaConcurrencyQuotas() {
  return EDGE_REGIONS.map((region) => {
    try {
      const { Quota } = aws(
        ["service-quotas", "get-service-quota", "--service-code", "lambda",
          "--quota-code", LAMBDA_CONCURRENCY_QUOTA_CODE],
        region,
      );
      return { region, value: typeof Quota?.Value === "number" ? Quota.Value : null };
    } catch (e) {
      return { region, value: null };
    }
  });
}

/**
 * Human-readable lines for the quota table, with a warning on low regions.
 *
 * @param {Array<{region: string, value: ?number}>} quotas From lambdaConcurrencyQuotas.
 * @returns {Array<string>} Lines to print.
 */
function quotaLines(quotas) {
  const lines = quotas.map(({ region, value }) => {
    const shown = value === null ? "unreadable" : String(value);
    const flag = value !== null && value < LOW_CONCURRENCY_QUOTA ? "  <- LOW" : "";
    return `  ${region.padEnd(16)} ${shown.padStart(6)}${flag}`;
  });
  const low = quotas.filter((q) => q.value !== null && q.value < LOW_CONCURRENCY_QUOTA);
  if (low.length) {
    lines.push(
      "",
      "  Every page request is a Lambda@Edge invocation, and each instance serves",
      "  10 requests per second: a region's ceiling is 10x its quota, and past it",
      `  CloudFront answers every page request there with a 503. Request an increase`,
      `  for quota ${LAMBDA_CONCURRENCY_QUOTA_CODE} (service: lambda) in: ${low.map((q) => q.region).join(", ")}.`,
    );
  }
  return lines;
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
  // association, not per path, and on here it delivers every POST body on the
  // site into the router's memory. The MCP transport is the one surface that
  // needs a body, and it gets its own behaviours (below) — the only place
  // IncludeBody is true.
  behaviour.LambdaFunctionAssociations = {
    Quantity: 1,
    Items: [
      {
        EventType: "origin-request",
        LambdaFunctionARN: outputs.EdgeRouterVersionArn,
        IncludeBody: false,
      },
    ],
  };
  changes.push(`origin-request  -> ${outputs.EdgeRouterVersionArn} (IncludeBody off)`);

  // Pages are never cached at the edge. Stated here in the words the operator
  // reads in the dry run, because it is the one change to their caching.
  if (behaviour.CachePolicyId !== MANAGED_CACHING_DISABLED_ID) {
    changes.push(
      `cache policy    ${behaviour.CachePolicyId} -> CachingDisabled ` +
        "(HTML is no longer cached at the edge; your origin answers every page request)",
    );
    behaviour.CachePolicyId = MANAGED_CACHING_DISABLED_ID;
  } else {
    changes.push("cache policy    CachingDisabled (already)");
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
 * Parse a "name=value, name=value" list into header pairs.
 *
 * The shape of the stack's OriginCustomHeaders output and of --origin-headers.
 * A value may itself contain "=" (a token might); only the first one splits.
 *
 * @param {string} text The list; blank or undefined gives no pairs.
 * @returns {Array<{HeaderName: string, HeaderValue: string}>} In list order.
 */
function parseHeaderPairs(text) {
  return String(text || "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, ...rest] = pair.split("=");
      if (!name.trim() || !rest.length) throw new Error(`bad header pair "${pair}": expected name=value`);
      return { HeaderName: name.trim(), HeaderValue: rest.join("=") };
    });
}

/**
 * Is this header one of NORG's? Header names are case-insensitive, and the
 * API writes them capitalised (X-Norg-Site-Id) where this CLI writes lowercase.
 *
 * @param {{HeaderName: string}} item A CustomHeaders item.
 * @returns {boolean} True for an x-norg-* header in any case.
 */
function isNorgHeader(item) {
  return String(item.HeaderName).toLowerCase().startsWith("x-norg-");
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
  // Nothing secret is injected here any more. The site key used to be written
  // into the distribution at this point, where anyone with
  // cloudfront:GetDistributionConfig could read it; the stack now publishes
  // x-norg-secret-arn instead and the key stays in Secrets Manager.
  const existing = (origin.CustomHeaders?.Items || []).filter((item) => !isNorgHeader(item));
  const items = [...existing, ...parseHeaderPairs(outputs.OriginCustomHeaders)];
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
    "origin headers  -> x-norg-* removed",
    "carve-outs      -> removed (yours kept)",
    "cache policy    CachingDisabled left in place (set your own back if you want HTML cached again)",
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
 * Lambda layout:
 *  1. MCP paths — the full router, never cached, and the ONLY place
 *     IncludeBody is on.
 *  2. Dynamic paths — no Lambda, NO cache (managed CachingDisabled), every
 *     method allowed. A 24 h TTL on /cart would serve one visitor's page to
 *     the next, so these must not share the static policy.
 *  3. Static assets — no Lambda, cached. Framework prefixes before bare
 *     suffixes, since prefix patterns are the more specific.
 *
 * Gate layout: group 2 only. The MCP carve-outs go — the gate treats MCP
 * descriptors as NORG surfaces itself, and a carve-out forwarding the viewer's
 * Host broke on origins that reject it (seen on NORG's own test site). The
 * static carve-outs go too: the function returns a static path untouched for
 * next to nothing, and imposing a cache policy on a customer's assets is not a
 * change the gate needs. The dynamic group stays because an origin group never
 * fails a POST over, and these are the paths that take them.
 *
 * @param {Object} outputs Stack outputs (policy ids and function ARNs).
 * @param {string} targetOriginId Origin the default behaviour points at.
 * @param {string} layout "lambda" or "gate".
 * @returns {Array<Object>} Behaviour items in match order.
 */
function carveOutBehaviours(outputs, targetOriginId, layout = "lambda") {
  const base = (PathPattern) => ({
    PathPattern,
    TargetOriginId: targetOriginId,
    ViewerProtocolPolicy: "redirect-to-https",
    Compress: true,
  });
  const mcp = MCP_PATH_PATTERNS.map((pattern) => ({
    ...base(pattern),
    AllowedMethods: ALL_METHODS,
    CachePolicyId: MANAGED_CACHING_DISABLED_ID,
    OriginRequestPolicyId: outputs.OriginRequestPolicyId,
    LambdaFunctionAssociations: {
      Quantity: 1,
      Items: [
        { EventType: "origin-request", LambdaFunctionARN: outputs.EdgeRouterVersionArn, IncludeBody: true },
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
  if (layout === "gate") return dynamic;
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
 * @param {string} layout "lambda" or "gate".
 * @returns {Array<string>} Summary lines.
 */
function addCarveOuts(config, outputs, layout = "lambda") {
  const behaviour = config.DefaultCacheBehavior;
  const existing = config.CacheBehaviors?.Items || [];
  const wanted = carveOutBehaviours(outputs, behaviour.TargetOriginId, layout);

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
  const groups = layout === "gate"
    ? "dynamic no-cache, straight to your origin on every method; no MCP or static carve-outs"
    : `${MCP_PATH_PATTERNS.length} MCP with the router, ${DYNAMIC_ROUTE_EXCLUSIONS.length} dynamic no-cache, the rest static`;
  return [
    `behaviours      +${ours.length} (${groups})` +
      (skipped ? `, ${skipped} skipped because you already have them` : "") +
      ` — ${theirs.length} of yours kept, ${total}/${CLOUDFRONT_BEHAVIOUR_QUOTA} used`,
  ];
}

/**
 * Put the gate function on the default behaviour's viewer-request slot.
 *
 * CloudFront allows ONE function per event type per behaviour, so an existing
 * viewer-request function is either ours (replaced: that is how an upgrade
 * lands) or someone else's (refused: replacing it is how an install breaks a
 * site in a way nobody can attribute). viewer-response is never touched.
 *
 * @param {Object} behaviour The default cache behaviour, mutated in place.
 * @param {string} functionArn The gate's ARN from the stack.
 * @returns {string} Summary line.
 */
function associateGate(behaviour, functionArn) {
  const items = behaviour.FunctionAssociations?.Items || [];
  const viewerRequest = items.find((item) => item.EventType === "viewer-request");
  if (viewerRequest && !OUR_FUNCTION_ARN.test(String(viewerRequest.FunctionARN))) {
    throw new Error(
      "this distribution already has a viewer-request CloudFront Function " +
        `(${viewerRequest.FunctionARN}).\n` +
        "CloudFront allows one per behaviour, and replacing it would silently take " +
        "over someone else's routing. Remove it first, or attach to a staging distribution.",
    );
  }
  const kept = items.filter((item) => item.EventType !== "viewer-request");
  const next = [...kept, { EventType: "viewer-request", FunctionARN: functionArn }];
  behaviour.FunctionAssociations = { Quantity: next.length, Items: next };
  const replaced = viewerRequest ? ` (replaces ${viewerRequest.FunctionARN})` : "";
  return `viewer-request  -> ${functionArn} (CloudFront Function)${replaced}`;
}

/**
 * Take the Lambda layout's router off the default behaviour, if it is there.
 *
 * Ours goes, because the gate replaces it. Someone else's origin-request
 * Lambda is refused for the same reason as in the Lambda layout — it would see
 * the rewritten URI and the origin group, and nobody could attribute what
 * happened next.
 *
 * @param {Object} behaviour The default cache behaviour, mutated in place.
 * @returns {?string} Summary line, or null when there was nothing to remove.
 */
function removeOurLambda(behaviour) {
  const items = behaviour.LambdaFunctionAssociations?.Items || [];
  const foreign = items.find(
    (item) => item.EventType === "origin-request" && !OUR_LAMBDA_ARN.test(String(item.LambdaFunctionARN)),
  );
  if (foreign) {
    throw new Error(
      "this distribution already has an origin-request Lambda@Edge function " +
        `(${foreign.LambdaFunctionARN}).\n` +
        "The gate rewrites the request before it; replacing or running under someone " +
        "else's routing is refused. Remove it first.",
    );
  }
  const kept = items.filter((item) => !OUR_LAMBDA_ARN.test(String(item.LambdaFunctionARN)));
  const removed = items.length - kept.length;
  behaviour.LambdaFunctionAssociations = { Quantity: kept.length, Items: kept };
  return removed ? `lambda          -> removed ${removed} NORG Lambda@Edge association(s) left by the Lambda layout` : null;
}

/**
 * The receptionist origin: NORG's HTTPS endpoint with its install headers.
 *
 * The headers are what authenticate this distribution to the receptionist:
 * whatever the stack published (the site id and environment) plus whatever the
 * caller passed in --origin-headers, which MUST include the mirror token. The
 * token is a secret and is not a stack parameter; an attach without it would
 * install a receptionist that 404s every request — the site would keep working
 * and the mirror would silently never serve, which is the failure this whole
 * repository is built to avoid.
 *
 * @param {Object} outputs Stack outputs.
 * @param {Object} options Parsed CLI options.
 * @returns {Object} A CloudFront Origin item.
 */
function receptionistOrigin(outputs, options) {
  const byName = new Map();
  for (const item of [...parseHeaderPairs(outputs.OriginCustomHeaders), ...parseHeaderPairs(options.originHeaders)]) {
    byName.set(item.HeaderName.toLowerCase(), item); // the caller's value wins on a clash
  }
  if (!byName.has(MIRROR_TOKEN_HEADER)) {
    throw new Error(
      `--origin-headers must include ${MIRROR_TOKEN_HEADER}: without it the receptionist ` +
        "answers 404 to everything and the install silently serves nothing.\n" +
        'Pass --origin-headers "X-Norg-Site-Id=<id>,X-Norg-Mirror-Token=<token>" as NORG issued them.',
    );
  }
  const items = [...byName.values()];
  return {
    Id: outputs.ReceptionistOriginId || DEFAULT_RECEPTIONIST_ORIGIN_ID,
    DomainName: outputs.ReceptionistHost,
    OriginPath: "",
    CustomHeaders: { Quantity: items.length, Items: items },
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: "https-only",
      OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
      // CloudFront's defaults. The receptionist answers a rendered page from
      // storage; a render it has to start is answered 404 and the viewer fails
      // over to the customer's origin, so a long wait buys nothing here.
      OriginReadTimeout: 30,
      OriginKeepaliveTimeout: 5,
    },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
    OriginShield: { Enabled: false },
  };
}

/**
 * Apply the gate layout to a distribution config, in place.
 *
 * @param {Object} config Distribution config.
 * @param {Object} outputs attach-gate stack outputs.
 * @param {Object} options Parsed CLI options.
 * @returns {Array<string>} Human-readable summary of the changes.
 */
function attachGate(config, outputs, options) {
  const behaviour = config.DefaultCacheBehavior;
  for (const key of ["FunctionArn", "ReceptionistHost", "CustomerOriginId"]) {
    if (!outputs[key]) throw new Error(`stack output ${key} is missing — is --stack an attach-gate.yaml stack?`);
  }
  // The function's origin group names the customer origin by Id. If the stack
  // was told a different Id from the one the default behaviour uses, every
  // agent request would fail at the edge (503) while humans saw nothing wrong.
  if (behaviour.TargetOriginId !== outputs.CustomerOriginId) {
    throw new Error(
      `the stack's CustomerOriginId is "${outputs.CustomerOriginId}" but the default ` +
        `behaviour points at "${behaviour.TargetOriginId}". The function would fail over ` +
        "to an origin that does not exist. Update the stack parameter to match.",
    );
  }
  const receptionist = receptionistOrigin(outputs, options);
  if (receptionist.Id === behaviour.TargetOriginId) {
    throw new Error(`the receptionist origin Id "${receptionist.Id}" is your default origin's Id; set ReceptionistOriginId on the stack`);
  }

  const changes = [];
  const lambdaLine = removeOurLambda(behaviour);
  if (lambdaLine) changes.push(lambdaLine);
  changes.push(associateGate(behaviour, outputs.FunctionArn));

  // The gate's headers (x-norg-gate, x-norg-ua, x-norg-viewer-ip, the version)
  // are viewer headers by the time the origin request is built; this managed
  // policy forwards all of them, every query string and every cookie, and
  // keeps the origin's own Host — the receptionist's is set by the function.
  if (behaviour.OriginRequestPolicyId !== MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID) {
    changes.push(
      `origin request  ${behaviour.OriginRequestPolicyId || "(none)"} -> AllViewerExceptHostHeader ` +
        "(the gate's headers and the full query string reach the receptionist)",
    );
    behaviour.OriginRequestPolicyId = MANAGED_ALL_VIEWER_EXCEPT_HOST_ORIGIN_REQUEST_ID;
  } else {
    changes.push("origin request  AllViewerExceptHostHeader (already)");
  }
  changes.push(`cache policy    ${behaviour.CachePolicyId || "(legacy ForwardedValues)"} left as it is — humans never reach NORG code, so your HTML caching is unchanged`);

  const origins = (config.Origins?.Items || []).filter((item) => item.Id !== receptionist.Id);
  const replaced = origins.length !== (config.Origins?.Items || []).length;
  origins.push(receptionist);
  config.Origins = { Quantity: origins.length, Items: origins };
  changes.push(
    `origin          ${replaced ? "~" : "+"}${receptionist.Id} (${receptionist.DomainName}, https-only, ` +
      `${receptionist.CustomHeaders.Quantity} custom headers incl. the mirror token; nothing is written on your own origin)`,
  );

  changes.push(...addCarveOuts(config, outputs, "gate"));
  return changes;
}

/**
 * Remove the gate layout from a distribution config, in place.
 *
 * Reverses attachGate and restores nothing else: the origin request policy
 * stays as attach left it (say so), the cache policy was never touched.
 *
 * @param {Object} config Distribution config.
 * @param {Object} options Parsed CLI options (for the receptionist origin Id).
 * @returns {Array<string>} Human-readable summary of the changes.
 */
function detachGate(config, options) {
  const behaviour = config.DefaultCacheBehavior;
  const receptionistId = options.receptionistOriginId || DEFAULT_RECEPTIONIST_ORIGIN_ID;
  if (receptionistId === behaviour.TargetOriginId) {
    throw new Error(`"${receptionistId}" is your default origin, not the receptionist; pass --receptionist-origin-id`);
  }

  const functions = (behaviour.FunctionAssociations?.Items || []).filter(
    (item) => !(item.EventType === "viewer-request" && OUR_FUNCTION_ARN.test(String(item.FunctionARN))),
  );
  behaviour.FunctionAssociations = { Quantity: functions.length, Items: functions };

  const keptBehaviours = (config.CacheBehaviors?.Items || []).filter((b) => !isOurs(b, config));
  config.CacheBehaviors = { Quantity: keptBehaviours.length, Items: keptBehaviours };

  const origins = (config.Origins?.Items || []).filter((item) => item.Id !== receptionistId);
  for (const origin of origins) {
    const kept = (origin.CustomHeaders?.Items || []).filter((item) => !isNorgHeader(item));
    origin.CustomHeaders = { Quantity: kept.length, Items: kept };
  }
  config.Origins = { Quantity: origins.length, Items: origins };

  return [
    "viewer-request  -> NORG gate function removed (your other functions kept)",
    `origin          -> ${receptionistId} removed; x-norg-* headers removed everywhere`,
    "carve-outs      -> removed (yours kept)",
    "origin request  AllViewerExceptHostHeader left in place (set your own back if you had one)",
    "cache policy    never changed by the gate layout",
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

  if (!options.distributionId || (!options.stack && !(options.detach && options.layout === "gate"))) {
    throw new Error("--distribution-id and --stack are required");
  }

  const outputs = options.detach ? {} : stackOutputs(options.stack);
  const current = aws(["cloudfront", "get-distribution-config", "--id", options.distributionId]);
  const config = current.DistributionConfig;

  const gate = options.layout === "gate";
  let changes;
  if (gate) changes = options.detach ? detachGate(config, options) : attachGate(config, outputs, options);
  else changes = options.detach ? detach(config) : attach(config, outputs, options);

  console.log(`\nDistribution ${options.distributionId} (${config.Comment || "no comment"}) — ${options.layout} layout`);
  console.log("Default cache behaviour changes:\n");
  for (const change of changes) console.log(`  ${change}`);

  if (!options.detach && !gate) {
    console.log("\nLambda concurrency quota per Lambda@Edge region (the 503 ceiling):\n");
    for (const line of quotaLines(lambdaConcurrencyQuotas())) console.log(line);
  }

  if (!options.apply) {
    console.log("\nDry run. Re-run with --apply to make these changes.");
    return;
  }

  console.log(
    gate
      ? "\nA distribution update takes 5-15 minutes to propagate. So does reverting."
      : "\nA distribution update takes 5-15 minutes to propagate, and a Lambda@Edge\n" +
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
  isOurs,
  attach,
  attachGate,
  carveOutBehaviours,
  detach,
  detachGate,
  parseArgs,
  parseHeaderPairs,
  quotaLines,
  setOriginHeaders,
};
