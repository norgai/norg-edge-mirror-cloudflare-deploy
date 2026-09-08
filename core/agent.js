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

import { classifyRequest, classifyScriptAutomation } from "../workers/lib/classify.mjs";
import { cidrVerdictFor } from "../workers/lib/cidr.mjs";

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
 * Verify the source against the operator's published CIDR set.
 *
 * Family-aware (workers/lib/cidr.mjs): an IPv6 client is measured against the
 * operator's IPv6 ranges when any are published, and is unmeasurable — null,
 * never false — when none are, so a crawler of an IPv4-only operator is not
 * refused for arriving over IPv6. Every operator manifest is IPv4-only today,
 * so this changes nothing live until one publishes IPv6.
 *
 * @param {string} clientIp Viewer IP, from the platform's own client field.
 * @param {Object} cidrRanges Per-operator ranges from the feed.
 * @param {Object} classification Classification from classifyAgent.
 * @returns {?boolean} Verdict, or null when no usable CIDR set applies.
 */
export function cidrVerdict(clientIp, cidrRanges, classification) {
  return cidrVerdictFor(clientIp, cidrRanges, classification);
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
