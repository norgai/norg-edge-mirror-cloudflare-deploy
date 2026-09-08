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
 * THE FETCH IS NEVER ON THE HOT PATH FOR HUMANS. The router answers an
 * ordinary browser, a search crawler and a static asset before it asks for
 * the key; only a bot-shaped request reaches this module, and then once per
 * container up to CACHE_TTL_MS.
 *
 * READ FROM THE REGION THAT RAN THE FUNCTION. Lambda@Edge executes in one of
 * thirteen regional edge caches, and the install replicates the secret to all
 * of them (a replica keeps the primary's ARN with only the region changed).
 * The reserved AWS_REGION variable names the executing region, so the read is
 * in-region instead of a round trip to Virginia from Sydney or Dublin. An
 * install whose secret is not replicated falls back to us-east-1 once and
 * remembers to go there for the container's life.
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

// A hard ceiling: a slow secret must not hold a visitor's request open. The
// local-region read normally answers in tens of milliseconds.
const SECRET_TIMEOUT_MS = 1500;

// Lambda@Edge functions are created in us-east-1 (an AWS restriction), and the
// install creates the primary secret alongside them.
const SECRET_REGION = "us-east-1";

// Where Lambda@Edge executes: the regions with a regional edge cache. The
// templates replicate the secret to every one of these but the primary.
export const EDGE_REGIONS = new Set([
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2",
  "eu-central-1", "eu-west-1", "eu-west-2", "sa-east-1",
]);

let cached = { value: null, fetchedAt: 0 };
// Set once a local-region read fails, so an install without replicas pays for
// the miss once per container rather than on every refresh.
let replicaMissing = false;

/**
 * Drop the cached key. Test seam only.
 *
 * @returns {void}
 */
export function __resetSecretCache() {
  cached = { value: null, fetchedAt: 0 };
  replicaMissing = false;
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
 * The same secret's ARN in another region.
 *
 * A replica's ARN differs from the primary's only in the region segment, so
 * this is a substitution, not a lookup.
 *
 * @param {string} arn Primary secret ARN.
 * @param {string} region Target region.
 * @returns {?string} The regional ARN, or null when the ARN is malformed.
 */
export function regionalArn(arn, region) {
  const parts = String(arn).split(":");
  if (parts.length < 7 || parts[2] !== "secretsmanager") return null;
  parts[3] = region;
  return parts.join(":");
}

/**
 * The region to read from first: the executing region when it holds a replica.
 *
 * @param {string} arn Primary secret ARN.
 * @returns {?string} A local edge region other than the primary's, or null.
 */
export function localReadRegion(arn) {
  // eslint-disable-next-line no-undef
  const region = typeof process !== "undefined" ? process.env.AWS_REGION : undefined;
  if (!region || !EDGE_REGIONS.has(region) || replicaMissing) return null;
  const primary = String(arn).split(":")[3];
  return region === primary ? null : region;
}

/**
 * One GetSecretValue call against one region.
 *
 * @param {string} arn Secret ARN in that region.
 * @param {string} region Region to call.
 * @returns {Promise<?string>} The parsed key, or null when the secret is empty.
 */
async function readSecret(arn, region) {
  const { SecretsManagerClient, GetSecretValueCommand } = loadClient();
  const client = new SecretsManagerClient({ region });
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }), {
    abortSignal: AbortSignal.timeout(SECRET_TIMEOUT_MS),
  });
  return parseSecret(result?.SecretString);
}

/**
 * Read the key from the local replica when there is one, else the primary.
 *
 * @param {string} arn Primary secret ARN.
 * @returns {Promise<?string>} The key, or null when neither read yields one.
 */
async function readNearest(arn) {
  const region = localReadRegion(arn);
  if (region) {
    try {
      const value = await readSecret(regionalArn(arn, region), region);
      if (value) return value;
    } catch (e) {
      // No replica here (or no permission for it): remember, and use the
      // primary for the rest of this container's life.
      replicaMissing = true;
      console.error("norg site key replica read failed, using primary", region, e?.name || e);
    }
  }
  return readSecret(arn, SECRET_REGION);
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
    const value = await readNearest(arn);
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
