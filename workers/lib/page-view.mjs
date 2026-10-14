/**
 * Shared citation page-view payload builder for NORG Cloudflare workers
 * (Epic CITE 01).
 *
 * Builds the canonical citation page-view event — the same field set defined
 * once in apps/api/app/schemas/citation_page_view.py and mirrored by
 * apps/api/tests/fixtures/citation_page_view.json. generateVisitorId
 * additionally mixes in a daily UTC salt.
 */

/**
 * The UTC calendar date (YYYY-MM-DD) used as the visitor-hash daily salt.
 * @param {Date} now Reference time.
 * @returns {string} The UTC date, ten chars.
 */
function _utcDateSalt(now) {
  return now.toISOString().slice(0, 10);
}

/**
 * Daily-salted, non-reversible visitor fingerprint.
 *
 * SHA-256 over ip:user-agent:accept-language:(UTC date), truncated to 16 bytes
 * (32 hex chars). The UTC date is the daily salt — it rotates the ingest dedup
 * key at midnight UTC, so a returning visitor is a new id the next day. `now`
 * defaults to real time (the public single-arg call is unchanged) and exists
 * only so tests can assert cross-date behaviour without mutating global Date.
 *
 * @param {Request} request Incoming request.
 * @param {Date} [now] Reference time; defaults to now.
 * @returns {Promise<string>} 32-hex-char fingerprint.
 */
export async function generateVisitorId(request, now = new Date()) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";
  const lang = request.headers.get("accept-language") || "";
  const data = `${ip}:${ua}:${lang}:${_utcDateSalt(now)}`;
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Detect device type from a user-agent string.
 * @param {string} userAgent The User-Agent header value.
 * @returns {string} 'mobile', 'tablet', or 'desktop'.
 */
export function detectDeviceType(userAgent) {
  if (!userAgent) return "desktop";
  const ua = userAgent.toLowerCase();
  // Tablets first (some tablet UAs also contain 'mobile').
  if (
    ua.includes("ipad") ||
    ua.includes("tablet") ||
    (ua.includes("android") && !ua.includes("mobile"))
  ) {
    return "tablet";
  }
  if (
    ua.includes("mobile") ||
    ua.includes("iphone") ||
    ua.includes("ipod") ||
    ua.includes("android")
  ) {
    return "mobile";
  }
  return "desktop";
}

/**
 * Resolve the visitor's country from Cloudflare metadata, or null.
 * @param {Request} request Incoming request.
 * @returns {?string} ISO country code, or null.
 */
function _country(request) {
  return (request.cf && request.cf.country) || request.headers.get("cf-ipcountry") || null;
}

/**
 * Assemble the canonical citation page-view event.
 *
 * Produces exactly the contract key set (CitationPageViewEvent / the shared
 * fixture): nullable fields carry null (never an absent key). The four
 * citation_* fields come from `detection` (from detectCitationReferral).
 *
 * @param {Request} request Incoming request.
 * @param {URL} url Parsed request URL.
 * @param {string} requestHost Host serving the page.
 * @param {{citation_source: string, citation_category: string,
 *   citation_source_host: string, citation_detection: string}} detection
 * @param {string} servedSurface The NORG surface serving the page.
 * @param {boolean} isFirstTouch Whether this is the visitor's first touch.
 * @returns {Promise<Object>} The full citation page-view event.
 */
export async function buildPageViewPayload(
  request,
  url,
  requestHost,
  detection,
  servedSurface,
  isFirstTouch,
) {
  return {
    domain: requestHost,
    path: url.pathname,
    visitor_id: await generateVisitorId(request),
    viewed_at: new Date().toISOString(),
    referrer: request.headers.get("referer"),
    utm_source: url.searchParams.get("utm_source"),
    utm_medium: url.searchParams.get("utm_medium"),
    utm_campaign: url.searchParams.get("utm_campaign"),
    country: _country(request),
    device_type: detectDeviceType(request.headers.get("user-agent")),
    user_agent: request.headers.get("user-agent"),
    ...detection,
    served_surface: servedSurface,
    is_first_touch: isFirstTouch,
  };
}
