/**
 * Reading the visitor's identity out of a request Vercel delivered.
 *
 * @description Vercel adapter for client IP, region and visit attributes.
 *
 * WHAT VERCEL PUBLISHES ABOUT THE CLIENT (vercel.com/docs/headers/request-headers):
 *
 *   x-real-ip              the client address
 *   x-forwarded-for        the same address; Vercel OVERWRITES an inbound value
 *                          rather than appending to it, to prevent spoofing
 *   x-vercel-ip-country    ISO country; -country-region, -city (URL-encoded)
 *   x-vercel-id            "<edge region>::<function region>::<request id>"
 *
 * Those guarantees hold ON VERCEL ONLY. The same Next.js app run with
 * `next start` behind no proxy passes x-real-ip straight from the client, and
 * trusting it there would let any caller name a crawler's IP and harvest the
 * mirror. So the address is read only when the code is running on Vercel
 * (the VERCEL system variable, which Vercel sets on every deployment) unless
 * the application supplies its own `getClientIp`. Off Vercel with no override
 * the address is empty and source verification fails closed.
 *
 * Vercel publishes no verified-bot signal to middleware, so — as on
 * CloudFront, Fastly and Bunny — verification is CIDR-only. A crawler whose
 * operator publishes no ranges is not diverted. That is a capability gap, and
 * the direction of the failure is the safe one.
 */

/**
 * Is this code running on a Vercel deployment?
 *
 * Read by literal name so the Edge runtime bundler resolves it.
 *
 * @returns {boolean} True on Vercel.
 */
export function onVercel() {
  return typeof process !== "undefined" && Boolean(process.env && process.env.VERCEL);
}

/**
 * The client address, for the CIDR gate.
 *
 * @param {Request} request Incoming request.
 * @param {Object} [options] Factory options.
 * @param {Function} [options.getClientIp] Application-supplied reader.
 * @param {boolean} [options.trustVercelHeaders] Force (or forbid) trusting
 *   Vercel's headers; defaults to whether the code runs on Vercel.
 * @returns {string} Client IP, or "" when none can be trusted.
 */
export function clientIp(request, options = {}) {
  if (typeof options.getClientIp === "function") {
    return String(options.getClientIp(request) || "").trim();
  }
  const trusted = options.trustVercelHeaders ?? onVercel();
  if (!trusted) return "";
  const real = (request.headers.get("x-real-ip") || "").trim();
  if (real) return real;
  const parts = (request.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // Vercel overwrites the header, so there is one entry; if that ever changes
  // to appending, the LAST entry is still the one the edge observed.
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * The Vercel edge region that answered, e.g. "syd1".
 *
 * @param {Request} request Incoming request.
 * @returns {?string} Region id, or null when not on Vercel.
 */
export function edgeRegion(request) {
  const id = request.headers.get("x-vercel-id") || "";
  const region = id.split("::")[0];
  return /^[a-z]{3}\d$/.test(region) ? region : null;
}

/**
 * Decode one URL-encoded Vercel geo header.
 *
 * @param {?string} value Raw header value.
 * @returns {?string} Decoded value, or null.
 */
function decodeGeo(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

/**
 * A request view core/visit.js can read the visitor's attributes from.
 *
 * core/visit.js reads the CloudFront-Viewer-* header names. Rather than change
 * core (which would change the CloudFront bundle and its pinned digest), the
 * Vercel equivalents are presented under those names on a view used ONLY to
 * build the visit header. Nothing else ever sees this object.
 *
 * @param {Request} request Incoming request.
 * @returns {{headers: Headers}} Minimal request view.
 */
export function visitView(request) {
  const headers = new Headers();
  const set = (name, value) => {
    if (value) headers.set(name, value);
  };
  set("user-agent", request.headers.get("user-agent"));
  set("cloudfront-viewer-country", request.headers.get("x-vercel-ip-country"));
  set("cloudfront-viewer-city", decodeGeo(request.headers.get("x-vercel-ip-city")));
  return { headers };
}
