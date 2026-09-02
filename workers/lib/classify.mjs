/**
 * Shared visitor classification for NORG Cloudflare workers.
 *
 * Single source of truth for `classifyRequest` and `classifyScriptAutomation`,
 * imported by both edge-router-worker.js (customer zones) and
 * r2-proxy-worker.js (NORG zone). These were previously duplicated between
 * those files and held in sync only by a byte-comparison parity test — the
 * duplication existed because the customer artifact must ship as a single
 * file and no bundler existed; esbuild (build.mjs) now inlines this module
 * into each built worker, so the single-file constraint holds without copies.
 *
 * Deliberately NOT in this module: FALLBACK_PATTERNS. The NORG-zone worker
 * keeps a baked-in fallback (it runs on our own infrastructure and is
 * entitled by definition); the customer-zone worker must never ship one —
 * a baked-in list is exactly how a revoked install would keep classifying
 * after NORG withdrew its feed. Keeping the fallback out of the shared
 * module preserves that asymmetry structurally.
 */

/**
 * Classify a user-agent against NORG's pattern list.
 * @param {string} userAgent Raw User-Agent header.
 * @param {Array<{pattern: string, company: string, purpose: string}>} patterns
 * @returns {{is_ai_bot: boolean, bot_name: ?string, company: ?string, purpose: ?string}}
 */
export function classifyRequest(userAgent, patterns) {
  if (!userAgent) {
    return { is_ai_bot: false, bot_name: null, company: null, purpose: null };
  }
  const ua = userAgent.toLowerCase();
  for (const pattern of patterns) {
    if (ua.includes(pattern.pattern)) {
      return {
        is_ai_bot: true,
        bot_name: pattern.pattern,
        company: pattern.company,
        purpose: pattern.purpose,
      };
    }
  }
  return { is_ai_bot: false, bot_name: null, company: null, purpose: null };
}

/**
 * Script-automation signatures, in match order.
 *
 * ORDER IS SIGNIFICANT: python-http must be tested before the generic
 * library families, and curl/wget derive their name from the user-agent
 * itself.
 */
const AUTOMATION_SIGNATURES = [
  {
    name: "headless-chrome",
    tokens: ["headlesschrome", "puppeteer", "playwright", "selenium", "phantomjs"],
  },
  {
    name: "python-http",
    // The runtime alone is not enough; a client library must be present too.
    test: (ua) =>
      ua.includes("python") &&
      ["aiohttp", "requests", "httpx", "urllib"].some((t) => ua.includes(t)),
  },
  {
    // "curl/8.4.0" -> "curl": the family name is the UA's own prefix.
    name: (ua) => ua.split("/")[0],
    test: (ua) => ua.startsWith("curl/") || ua.startsWith("wget/"),
  },
  { name: "node-http", tokens: ["node-fetch", "axios", "undici"] },
  {
    name: "security-scanner",
    tokens: ["l9scan", "leakix", "nuclei", "zgrab", "masscan"],
  },
  {
    name: "go-http",
    test: (ua) => ua.startsWith("go-http-client") || ua.includes("go-resty"),
  },
  {
    name: "java-http",
    test: (ua) =>
      ua.startsWith("java/") ||
      ua.includes("apache-httpclient") ||
      ua.includes("okhttp"),
  },
];

/**
 * Build a script-automation classification.
 * @param {string} botName Automation family name.
 * @returns {Object} Classification object.
 */
function automationResult(botName) {
  return {
    is_ai_bot: true,
    bot_name: botName,
    company: "script_automation",
    purpose: "unknown",
  };
}

/**
 * Detect headless browsers, HTTP libraries and scanners.
 * @param {string} userAgent Raw User-Agent header.
 * @returns {?Object} Classification, or null when not automation.
 */
export function classifyScriptAutomation(userAgent) {
  const ua = (userAgent || "").toLowerCase();
  for (const signature of AUTOMATION_SIGNATURES) {
    const matched = signature.tokens
      ? signature.tokens.some((token) => ua.includes(token))
      : signature.test(ua);
    if (matched) {
      const name =
        typeof signature.name === "function" ? signature.name(ua) : signature.name;
      return automationResult(name);
    }
  }
  return null;
}
