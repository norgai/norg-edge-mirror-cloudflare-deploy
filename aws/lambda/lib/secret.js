/**
 * Fetching the site key from Secrets Manager, at the edge.
 *
 * @description Replaces the origin custom header that used to carry the key.
 *
 * Lambda@Edge has no environment variables, so config arrives as origin custom
 * headers (lib/config.js). That is fine for identifiers and URLs, but it put
 * the one credential this install holds into the distribution's configuration,
 * where anyone with cloudfront:GetDistributionConfig could read it, and into a
 * second copy on the heartbeat function. The key now lives in Secrets Manager
 * instead: one place, IAM-scoped, and every read auditable in CloudTrail.
 *
 * THE FETCH IS NEVER ON THE HOT PATH FOR HUMANS. The early exits — kill switch,
 * non-GET, static assets, skip list — return before any NORG call, so they
 * never reach this module. The first request per container that needs the
 * pattern feed pays one lookup, and the value is cached for the container's
 * life up to CACHE_TTL_MS.
 *
 * Rule 1 governs every failure: this module returns null rather than throwing,
 * and a null key means the router passes the request to the customer's origin.
 * A Secrets Manager outage degrades the product; it cannot break the site.
 */

// Long enough that a busy container fetches roughly once, short enough that a
// rotated key takes effect without waiting for the container to be recycled.
// AWS's own Lambda@Edge secrets pattern caches for the container's whole life
// and has exactly that gap; this deliberately does not copy it.
const CACHE_TTL_MS = 15 * 60 * 1000;

// Secrets Manager is reached cross-region from most edge locations, so this is
// deliberately generous compared with the other edge timeouts — but it is still
// a hard ceiling, because a slow secret must not hold a visitor's request open.
const SECRET_TIMEOUT_MS = 1500;

// Lambda@Edge functions run in us-east-1 (an AWS restriction), and the install
// creates the secret alongside them, so the client is pinned there rather than
// inheriting a region from the execution environment.
const SECRET_REGION = "us-east-1";

let cached = { value: null, fetchedAt: 0 };

/**
 * Drop the cached key. Test seam only.
 *
 * @returns {void}
 */
export function __resetSecretCache() {
  cached = { value: null, fetchedAt: 0 };
}

/**
 * Seed the cache so a test never reaches Secrets Manager. Test seam only.
 *
 * @param {?string} value Key to serve, or null to simulate a failed fetch.
 * @returns {void}
 */
export function __primeSecretCache(value) {
  cached = { value, fetchedAt: Date.now() };
}

/**
 * Load the Secrets Manager client from the runtime.
 *
 * Required lazily and from the runtime rather than bundled, so the deployed
 * artifact stays a readable, dependency-free file that can be diffed against
 * the public repository. If a future runtime stops providing the SDK this
 * throws, and the caller degrades to passthrough instead of a 502.
 *
 * @returns {Object} The @aws-sdk/client-secrets-manager module.
 */
function loadClient() {
  // eslint-disable-next-line no-undef
  return require("@aws-sdk/client-secrets-manager");
}

/**
 * Read the secret's plaintext, whatever shape it was stored in.
 *
 * Accepts both a bare string and a JSON object with a NORG_SITE_KEY field, so
 * an operator who used the console's key/value editor gets a working install
 * rather than a silent passthrough.
 *
 * @param {?string} secretString Raw SecretString from the API.
 * @returns {?string} The site key, or null when absent.
 */
export function parseSecret(secretString) {
  if (!secretString) return null;
  const trimmed = secretString.trim();
  if (!trimmed.startsWith("{")) return trimmed || null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed?.NORG_SITE_KEY || parsed?.site_key || null;
  } catch (e) {
    return null;
  }
}

/**
 * The site key for this install, cached per container.
 *
 * @param {Object} env Config object carrying NORG_SECRET_ARN.
 * @returns {Promise<?string>} The key, or null when it cannot be obtained.
 */
export async function getSiteKey(env) {
  const arn = env?.NORG_SECRET_ARN;
  if (!arn) return null;

  const age = Date.now() - cached.fetchedAt;
  if (cached.value && age < CACHE_TTL_MS) return cached.value;

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = loadClient();
    const client = new SecretsManagerClient({ region: SECRET_REGION });
    const result = await client.send(new GetSecretValueCommand({ SecretId: arn }), {
      abortSignal: AbortSignal.timeout(SECRET_TIMEOUT_MS),
    });
    const value = parseSecret(result?.SecretString);
    if (!value) return null;
    cached = { value, fetchedAt: Date.now() };
    return value;
  } catch (e) {
    // Deliberately not re-thrown and deliberately not cached as a negative: the
    // next request retries, and this one serves the customer's origin.
    console.error("norg site key fetch failed", e);
    return null;
  }
}
