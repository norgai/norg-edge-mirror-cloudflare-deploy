/**
 * Classifying a visitor, and deciding whether they may be diverted.
 *
 * @description Bot classification, serving policy, and source verification.
 *
 * Three gates stand between "this user-agent looks like an AI crawler" and
 * "serve it the mirror", and all three must pass:
 *
 *  1. `classifyAgent` — does the feed name this user-agent at all?
 *  2. `mayDivert` — has NORG published `serving_policy: "divert"` for it? The
 *     column defaults to never_divert, so a newly-added or unclassified pattern
 *     is fail-safe, and an operator can withdraw a crawler by flipping one
 *     column with no redeploy.
 *  3. `verifiedSource` — is the source IP genuinely that operator's? A
 *     user-agent alone is trivially spoofable (`curl -A "GPTBot/1.4"`).
 *
 * WHERE CLOUDFRONT IS WEAKER THAN CLOUDFLARE. On Cloudflare, gate 3 falls back
 * to `request.cf.verifiedBotCategory` when the feed publishes no CIDR set for
 * an operator. CloudFront exposes no verified-bot signal of any kind — AWS's
 * equivalent lives in AWS WAF Bot Control, a separately-priced product with a
 * different integration shape — so verification here is CIDR-only.
 *
 * The consequence is real and must not be papered over: a crawler whose
 * operator publishes no CIDR ranges will NOT be diverted on CloudFront, where
 * it would be on Cloudflare. That is a capability gap, not a bug, and the
 * direction of the failure is the safe one — it under-serves agents rather than
 * over-serving humans, and gate 3 still fails closed.
 */

import { classifyRequest, classifyScriptAutomation } from "../../../workers/lib/classify.mjs";

/**
 * The serving policy NORG published for a matched pattern.
 *
 * Looked up separately rather than returned by classifyRequest, because that
 * function is asserted byte-for-byte against the NORG-side workers by a parity
 * test — the two must keep agreeing on WHICH crawler a user-agent is, even
 * though only the router acts on the policy.
 *
 * @param {?string} botName Matched pattern string.
 * @param {Array} patterns Patterns from NORG.
 * @returns {?string} Published policy, or undefined when the feed omits it.
 */
function servingPolicyFor(botName, patterns) {
  const match = patterns.find((p) => p.pattern === botName);
  return match ? match.serving_policy : undefined;
}

/**
 * Classify a visitor: named patterns first, then script automation.
 *
 * @param {string} userAgent Raw User-Agent header.
 * @param {Array} patterns Patterns from NORG.
 * @returns {Object} Classification carrying the published serving_policy.
 */
export function classifyAgent(userAgent, patterns) {
  const patternMatch = classifyRequest(userAgent, patterns);
  if (patternMatch.is_ai_bot) {
    return { ...patternMatch, serving_policy: servingPolicyFor(patternMatch.bot_name, patterns) };
  }
  // Script automation is not in ai_bot_patterns, so NORG publishes no policy
  // for it. never_divert is what applies: curl and friends are identified for
  // analytics, never served the mirror.
  const automation = classifyScriptAutomation(userAgent);
  if (automation) return { ...automation, serving_policy: "never_divert" };
  return patternMatch;
}

/**
 * Has NORG authorised diverting this agent?
 *
 * @param {Object} classification Classification from classifyAgent.
 * @returns {boolean} True only when the published policy is "divert".
 */
export function mayDivert(classification) {
  return classification.serving_policy === "divert";
}

/**
 * Parse an IPv4 dotted quad into a 32-bit integer.
 *
 * @param {?string} ip Address to parse.
 * @returns {?number} Integer value, or null when not valid IPv4.
 */
function ipv4ToInt(ip) {
  const parts = (ip || "").split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Is an IPv4 address inside a CIDR block?
 *
 * @param {number} ipInt Address as a 32-bit integer.
 * @param {string} cidr Block in "a.b.c.d/len" form ("/len" optional).
 * @returns {boolean} True when the address falls inside the block.
 */
export function ipv4InCidr(ipInt, cidr) {
  const [network, bitsRaw] = String(cidr).split("/");
  const networkInt = ipv4ToInt(network);
  if (networkInt === null) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  // A /0 would shift by 32, which JS evaluates as a shift by 0 — special-cased.
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((networkInt & mask) >>> 0);
}

/**
 * Verify the source against the operator's published CIDR set.
 *
 * @param {string} clientIp Viewer IP, from CloudFront's own clientIp field.
 * @param {Object} cidrRanges Per-operator ranges from the feed.
 * @param {Object} classification Classification from classifyAgent.
 * @returns {?boolean} Verdict, or null when no usable CIDR set applies.
 */
export function cidrVerdict(clientIp, cidrRanges, classification) {
  const entry = (cidrRanges || {})[classification.company];
  const cidrs = entry && Array.isArray(entry.cidrs) ? entry.cidrs : null;
  if (!cidrs || !cidrs.length) return null;
  // The published sets are IPv4-only, so an IPv6 client is not a mismatch — it
  // is unmeasurable here, and answering false would refuse every IPv6 bot.
  const ipInt = ipv4ToInt(clientIp);
  if (ipInt === null) return null;
  return cidrs.some((cidr) => ipv4InCidr(ipInt, cidr));
}

/**
 * Is the request's source genuinely the operator it claims to be?
 *
 * CIDR-only on CloudFront (see the module header). `clientIp` comes from
 * CloudFront itself rather than a header, so unlike an X-Forwarded-For value it
 * is not attacker-controlled.
 *
 * Fails CLOSED: no usable signal means not verified, so the request falls
 * through to the origin.
 *
 * @param {string} clientIp Viewer IP from the CloudFront event.
 * @param {Object} cidrRanges Per-operator ranges from the feed.
 * @param {Object} classification Classification from classifyAgent.
 * @returns {boolean} True only when the source is verified.
 */
export function verifiedSource(clientIp, cidrRanges, classification) {
  return cidrVerdict(clientIp, cidrRanges, classification) === true;
}

/**
 * Synthetic classification for a ?agent=true override hit.
 *
 * Tags the event distinctly from genuine UA+IP-verified bot diverts so override
 * usage is visible in analytics rather than inflating real-bot counts.
 *
 * @returns {Object} Classification identifying the override.
 */
export function agentOverrideClassification() {
  return {
    is_ai_bot: true,
    bot_name: "agent_param_override",
    company: "agent_param_override",
    purpose: "override",
  };
}

/**
 * Classification used for surfaces addressed by URL rather than by caller.
 *
 * @returns {Object} Non-bot classification.
 */
export function anonymousClassification() {
  return { is_ai_bot: false, bot_name: null, company: null, purpose: null };
}
