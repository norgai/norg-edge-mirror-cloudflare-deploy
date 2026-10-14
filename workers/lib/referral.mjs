/**
 * Shared citation-referral detection for NORG Cloudflare workers (Epic CITE 01).
 *
 * Classifies whether a request arrived from an AI-assistant / search citation
 * surface, UTM-first then by the parsed referrer HOST (prod: 569 UTM-tagged AI
 * arrivals vs 127 by referer header over 30 days). Matching is on the referrer
 * URL's .hostname ONLY — never the whole URL string — so a path that merely
 * contains an assistant's name never triggers a match.
 *
 * SOURCE_REGISTRY is the ONE place a host maps to a normalised source name; it
 * is read exclusively through _lookupSource so swapping it for a fetched feed
 * later is a single-function change. Vocabulary mirrors the Python
 * apps/api/app/services/watch/referrer_classifier.py assistant set, but this
 * module is deliberately self-contained (no cross-language parity test).
 *
 * This module never emits citation_detection "js_referrer" — that value belongs
 * to the later browser-beacon path, not the workers.
 */

// The ONLY host -> normalised source map. { host: { source, category } }.
// Search engines default to category "search" unless a corroborating AI UTM
// promotes them (see _classifyHost). gemini.google.com is an AI assistant
// directly and is matched exactly before the google.com search suffix.
export const SOURCE_REGISTRY = {
  "chatgpt.com": { source: "chatgpt", category: "ai_assistant" },
  "chat.openai.com": { source: "chatgpt", category: "ai_assistant" },
  "perplexity.ai": { source: "perplexity", category: "ai_search" },
  "claude.ai": { source: "claude", category: "ai_assistant" },
  "gemini.google.com": { source: "gemini", category: "ai_assistant" },
  "copilot.microsoft.com": { source: "copilot", category: "ai_assistant" },
  "google.com": { source: "google", category: "search" },
  "bing.com": { source: "bing", category: "search" },
};

// utm_source (lowercased) -> normalised source, the AI-UTM signal. A UTM here
// both flags an arrival as AI and (when it agrees with the host) sets "both".
// Both the provider slug (openai) AND the host-form the assistants actually
// stamp on their citation links (utm_source=chatgpt.com) are keyed, so a real
// ChatGPT/Perplexity/… referral is caught (Epic CITE 04, AC4).
export const AI_UTM_SOURCE_MAP = {
  openai: { source: "chatgpt", category: "ai_assistant" },
  "chatgpt.com": { source: "chatgpt", category: "ai_assistant" },
  "chat.openai.com": { source: "chatgpt", category: "ai_assistant" },
  perplexity: { source: "perplexity", category: "ai_search" },
  "perplexity.ai": { source: "perplexity", category: "ai_search" },
  claude: { source: "claude", category: "ai_assistant" },
  "claude.ai": { source: "claude", category: "ai_assistant" },
  gemini: { source: "gemini", category: "ai_assistant" },
  "gemini.google.com": { source: "gemini", category: "ai_assistant" },
  copilot: { source: "copilot", category: "ai_assistant" },
  "copilot.microsoft.com": { source: "copilot", category: "ai_assistant" },
  "copilot.com": { source: "copilot", category: "ai_assistant" },
};

/**
 * Parse the referrer header's host (lowercased), or null when absent/unparseable.
 * @param {Request} request Incoming request.
 * @returns {?string} The referrer hostname, or null.
 */
function _referrerHost(request) {
  const referrer = request.headers.get("referer");
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Registrable domain via a last-two-labels heuristic (no PSL in-worker).
 * NOTE: multi-label public suffixes (e.g. example.co.uk) collapse to co.uk;
 * accepted as a rare, low-impact false self-referral.
 * @param {string} host A lowercased hostname.
 * @returns {string} The last two labels of the host.
 */
function _registrableDomain(host) {
  return host.split(".").slice(-2).join(".");
}

/**
 * Look a host up in SOURCE_REGISTRY: exact match first, then domain suffix
 * (so gemini.google.com resolves to its own entry, not google.com).
 *
 * Search-engine entries (category "search") match ONLY their exact host or the
 * `www.` form: google.com / bing.com carry dozens of non-search subdomains
 * (mail., docs., drive., calendar.), and a link clicked out of Gmail or a Doc
 * is not a search citation. AI-assistant entries keep full suffix matching.
 * @param {string} host A lowercased hostname.
 * @returns {?{source: string, category: string}} Registry entry, or null.
 */
function _lookupSource(host) {
  if (Object.prototype.hasOwnProperty.call(SOURCE_REGISTRY, host)) {
    return SOURCE_REGISTRY[host];
  }
  for (const key of Object.keys(SOURCE_REGISTRY)) {
    if (!host.endsWith(`.${key}`)) continue;
    const entry = SOURCE_REGISTRY[key];
    if (entry.category !== "search" || host === `www.${key}`) return entry;
  }
  return null;
}

/**
 * The AI-UTM entry for this request's utm_source, or null.
 * @param {URL} url Request URL.
 * @returns {?{source: string, category: string}} UTM entry, or null.
 */
function _utmEntry(url) {
  const utm = (url.searchParams.get("utm_source") || "").toLowerCase();
  return utm ? AI_UTM_SOURCE_MAP[utm] || null : null;
}

/**
 * Assemble a detection result object.
 * @returns {{citation_source: string, citation_category: string,
 *   citation_source_host: string, citation_detection: string}}
 */
function _result(source, category, host, detection) {
  return {
    citation_source: source,
    citation_category: category,
    citation_source_host: host,
    citation_detection: detection,
  };
}

/**
 * Classify when the referrer host is in the registry.
 * @param {{source: string, category: string}} hostEntry Registry entry.
 * @param {string} referrerHost Parsed referrer host.
 * @param {?{source: string, category: string}} utmEntry AI-UTM entry, or null.
 */
function _classifyHost(hostEntry, referrerHost, utmEntry) {
  if (hostEntry.category === "search") {
    // Search hosts stay "search" unless a corroborating AI UTM promotes them.
    if (utmEntry) return _result(hostEntry.source, "ai_search", referrerHost, "both");
    return _result(hostEntry.source, "search", referrerHost, "referer");
  }
  // AI-assistant host: "both" only when the UTM names the same source.
  const agree = Boolean(utmEntry) && utmEntry.source === hostEntry.source;
  return _result(
    hostEntry.source,
    hostEntry.category,
    referrerHost,
    agree ? "both" : "referer",
  );
}

/**
 * Classify when the referrer host is NOT in the registry.
 * An unknown host with an AI UTM becomes other_ai (raw host preserved); a UTM
 * with no referrer host is the named source; otherwise there is no citation.
 * @param {?string} referrerHost Parsed referrer host, or null.
 * @param {?{source: string, category: string}} utmEntry AI-UTM entry, or null.
 */
function _classifyNoHost(referrerHost, utmEntry) {
  if (!utmEntry) return null;
  if (referrerHost) {
    return _result("other_ai", "ai_assistant", referrerHost, "utm");
  }
  return _result(utmEntry.source, utmEntry.category, "", "utm");
}

/**
 * Detect whether a request is a citation referral.
 *
 * Reads the UTM signal first, then the parsed referrer host. Returns null when
 * the referrer's registrable domain equals the request host (self-referral) or
 * when neither signal indicates a citation surface.
 *
 * @param {Request} request Incoming request (for the Referer header).
 * @param {URL} url Parsed request URL (for utm_source).
 * @param {string} requestHost Host serving the page.
 * @returns {?{citation_source: string, citation_category: string,
 *   citation_source_host: string, citation_detection: string}} Detection, or null.
 */
export function detectCitationReferral(request, url, requestHost) {
  const referrerHost = _referrerHost(request);
  const utmEntry = _utmEntry(url);
  if (
    referrerHost &&
    _registrableDomain(referrerHost) === _registrableDomain(requestHost.toLowerCase())
  ) {
    return null; // self-referral
  }
  const hostEntry = referrerHost ? _lookupSource(referrerHost) : null;
  if (hostEntry) return _classifyHost(hostEntry, referrerHost, utmEntry);
  return _classifyNoHost(referrerHost, utmEntry);
}
