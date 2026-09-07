/**
 * Install the NORG edge router onto a Bunny pull zone.
 *
 * Usage:
 *   BUNNY_API_KEY=... SITE_ID=... NORG_SITE_KEY=... \
 *   ORIGIN_URL=https://www.example.com PULL_ZONE_NAME=... \
 *   EDGE_HOSTNAME=edge.example.com \
 *   node bunny/install.mjs
 *
 * Everything the install needs comes from the environment; nothing is baked
 * into this file, because this repository is public. The script is idempotent:
 * run it again to push a new bundle or change a setting.
 *
 * WHAT IT DOES, and why each step is not optional:
 *  1. Creates (or reuses) a MIDDLEWARE edge script and uploads the committed
 *     bundle, then publishes it — an unpublished script never runs.
 *  2. Writes SITE_ID and the flags as environment VARIABLES, and NORG_SITE_KEY
 *     as an environment SECRET. Bunny will not read a secret back out.
 *  3. Creates (or reuses) a pull zone pointed at the customer's origin, with
 *     the origin's own Host header, and links the script to it.
 *  4. Checks whether the origin's HTML is cacheable, because Bunny runs
 *     `onOriginRequest` on a cache MISS only. A cacheable origin means the
 *     router is skipped on every cache HIT. See the README, "The cache is the
 *     hazard", and CACHE_BYPASS below.
 *  5. Attaches the customer-facing hostname and turns on AutoSSL.
 *
 * CACHE_BYPASS=true is the opt-in blunt instrument for step 4. It is NOT the
 * default, and the reason is rule 1. Forcing the cache off is a pull-zone
 * setting (`CacheControlMaxAgeOverride: 0`), and Bunny then rewrites the
 * CLIENT-facing `Cache-Control` on every response to `public, max-age=0` —
 * measured on a live zone, where an asset served `public, max-age=31536000,
 * immutable` came back as `public, max-age=0`. That is a real performance
 * regression on the customer's own site, so it is offered rather than applied.
 * When it is used, an edge rule restores `private, no-store` on NORG-generated
 * responses, which the override would otherwise have weakened.
 *
 * Two narrower shapes were tried and do not work on Bunny today, so do not
 * re-derive them: `CDN-Cache-Control: private, no-store` stamped by the script
 * in `onOriginResponse` is ignored (the response was cached anyway, verified
 * with cdn-cache: HIT), and an edge rule excluding asset extensions is refused
 * because a trigger accepts at most 5 patterns.
 */

const API = "https://api.bunny.net";

const REQUIRED = ["BUNNY_API_KEY", "SITE_ID", "NORG_SITE_KEY", "ORIGIN_URL", "PULL_ZONE_NAME"];

// Plain configuration. NORG_SITE_KEY is deliberately absent: it is a secret.
const VARIABLE_NAMES = [
  "SITE_ID",
  "NORG_API_URL",
  "NORG_CONTENT_BASE",
  "STRIP_FALLBACK_ENABLED",
  "EDGE_DISABLED",
  "LAZY_RENDER_ENABLED",
  "EDGE_ENV",
  "EDGE_EVENTS_VERBOSE",
];

/**
 * Call the Bunny API, failing loudly on anything but a 2xx.
 *
 * @param {string} method HTTP method.
 * @param {string} path API path beginning with "/".
 * @param {?Object} body JSON body, or null.
 * @returns {Promise<*>} Parsed JSON, or null for an empty body.
 */
async function api(method, path, body = null) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      AccessKey: process.env.BUNNY_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Find an existing middleware script by name, or create one.
 *
 * @param {string} name Script name.
 * @returns {Promise<Object>} The script record.
 */
async function ensureScript(name) {
  const listed = await api("GET", "/compute/script?page=1&perPage=1000");
  const existing = (listed.Items || []).find((s) => s.Name === name && !s.Deleted);
  if (existing) return existing;
  // ScriptType 2 = Middleware (0 = DNS, 1 = Standalone).
  return api("POST", "/compute/script", { Name: name, ScriptType: 2, Code: "" });
}

/**
 * Write the plain configuration variables onto the script.
 *
 * Bunny has no upsert: an existing variable is updated by id, a new one added.
 *
 * @param {Object} script Script record.
 * @param {Object} values Variable name -> value.
 * @returns {Promise<void>} Resolves when every variable is written.
 */
async function writeVariables(script, values) {
  const current = new Map((script.EdgeScriptVariables || []).map((v) => [v.Name, v.Id]));
  for (const [name, value] of Object.entries(values)) {
    const id = current.get(name);
    // The update model takes only DefaultValue/Required; the add model also
    // takes the name. They are not interchangeable.
    if (id) {
      await api("POST", `/compute/script/${script.Id}/variables/${id}`, {
        Required: false,
        DefaultValue: String(value),
      });
    } else {
      await api("POST", `/compute/script/${script.Id}/variables/add`, {
        Name: name,
        Required: false,
        DefaultValue: String(value),
      });
    }
    console.log(`  variable ${name} = ${value}`);
  }
}

/**
 * Write the site key as an environment secret.
 *
 * Bunny lists secrets by name and id only — the plaintext cannot be read back
 * through the API or the dashboard once written, so an existing secret is
 * overwritten rather than compared.
 *
 * @param {Object} script Script record.
 * @param {string} siteKey The per-site key.
 * @returns {Promise<void>} Resolves when the secret is written.
 */
async function writeSecret(script, siteKey) {
  // The listing returns names, ids and timestamps only — never plaintext.
  const listed = await api("GET", `/compute/script/${script.Id}/secrets`);
  const existing = (listed?.Secrets || []).find((entry) => entry.Name === "NORG_SITE_KEY");
  if (existing) {
    // The update model carries the value alone; the add model also the name.
    await api("POST", `/compute/script/${script.Id}/secrets/${existing.Id}`, { Secret: siteKey });
  } else {
    await api("POST", `/compute/script/${script.Id}/secrets`, {
      Name: "NORG_SITE_KEY",
      Secret: siteKey,
    });
  }
  console.log("  secret NORG_SITE_KEY written (write-only; Bunny will not read it back)");
}

/**
 * Find an existing pull zone by name, or create one for this origin.
 *
 * @param {string} name Pull zone name.
 * @param {string} originUrl The customer's origin.
 * @returns {Promise<Object>} The pull zone record.
 */
async function ensurePullZone(name, originUrl) {
  const listed = await api("GET", "/pullzone?page=1&perPage=1000");
  const existing = (listed.Items || []).find((z) => z.Name === name);
  if (existing) return existing;
  return api("POST", "/pullzone", { Name: name, OriginUrl: originUrl });
}

/**
 * Apply the settings the router depends on.
 *
 * CacheControlMaxAgeOverride = 0 is the load-bearing one: `onOriginRequest`
 * runs on a cache MISS only, so any cached response is served without the
 * router. Everything else here is ordinary origin configuration.
 *
 * @param {Object} zone Pull zone record.
 * @param {number} scriptId Middleware script id.
 * @param {string} originUrl The customer's origin.
 * @returns {Promise<void>} Resolves once applied.
 */
async function configurePullZone(zone, scriptId, originUrl) {
  const bypass = process.env.CACHE_BYPASS === "true";
  await api("POST", `/pullzone/${zone.Id}`, {
    OriginUrl: originUrl,
    OriginHostHeader: new URL(originUrl).host,
    AddHostHeader: false,
    MiddlewareScriptId: scriptId,
    // -1 means "respect the origin", which leaves the customer's own cache
    // headers byte-for-byte unchanged. 0 forces every request to reach the
    // router and rewrites those headers — see the module header.
    CacheControlMaxAgeOverride: bypass ? 0 : -1,
    CacheControlPublicMaxAgeOverride: bypass ? 0 : -1,
    CacheErrorResponses: false,
    EnableSmartCache: false,
    EnableAutoSSL: true,
  });
  if (bypass) await restoreNoStoreOnNorgResponses(zone);
}

/**
 * Put `private, no-store` back on NORG-generated responses.
 *
 * Only needed alongside CACHE_BYPASS: the pull-zone override replaces the
 * client-facing Cache-Control on EVERY response, including the mirror's own
 * `private, no-store`, which would leave tenant content marked publicly
 * cacheable. The trigger is the response header the router stamps, so the
 * customer's own responses are not touched by this rule.
 *
 * @param {Object} zone Pull zone record.
 * @returns {Promise<void>} Resolves once the rule exists.
 */
async function restoreNoStoreOnNorgResponses(zone) {
  await api("POST", `/pullzone/${zone.Id}/edgerules/addOrUpdate`, {
    ActionType: "OverrideBrowserCacheResponseHeader",
    ActionParameter1: "private, no-store",
    Description: "NORG: tenant content is never cacheable",
    Enabled: true,
    TriggerMatchingType: 0,
    Triggers: [
      {
        Type: "ResponseHeader",
        PatternMatches: ["*"],
        PatternMatchingType: 0,
        Parameter1: "X-Norg-Edge",
      },
    ],
  });
  console.log("  edge rule: NORG responses keep private, no-store");
}

/**
 * Report whether the origin's own HTML would be cached by Bunny.
 *
 * This is the single most important thing to know about a Bunny install and it
 * is invisible from the control plane, so it is measured rather than assumed.
 * A cacheable origin means `onOriginRequest` — and therefore the whole router —
 * is skipped on every cache HIT.
 *
 * @param {string} originUrl The customer's origin.
 * @returns {Promise<void>} Resolves after reporting.
 */
async function warnIfOriginIsCacheable(originUrl) {
  let cacheControl = "";
  try {
    const response = await fetch(originUrl, { headers: { "User-Agent": "norg-edge-install" } });
    cacheControl = response.headers.get("cache-control") || "";
  } catch (error) {
    console.log(`  could not probe the origin's cache headers: ${error.message}`);
    return;
  }
  const uncacheable = /no-store|no-cache|private|max-age=0/i.test(cacheControl);
  console.log(`  origin Cache-Control: ${cacheControl || "(none)"}`);
  if (uncacheable) {
    console.log("  origin HTML is not cacheable, so the router runs on every request.");
    return;
  }
  console.log("  WARNING: this origin's HTML IS cacheable. Bunny runs the router on a");
  console.log("  cache MISS only, so agents will be served cached origin pages and the");
  console.log("  mirror will never appear. Re-run with CACHE_BYPASS=true, and read the");
  console.log("  README section \"The cache is the hazard\" before you do.");
}

/**
 * Attach the customer-facing hostname, get it a certificate, and force HTTPS.
 *
 * ORDER MATTERS, and the failure is not obvious. Bunny will not accept
 * `setForceSSL` for a hostname it has no certificate for — it answers
 * `pullzone.hostname_ssl_not_enabled` — and it cannot issue one until the
 * hostname's DNS already resolves to the pull zone, because the ACME challenge
 * is answered by the zone itself. So on a first install this step runs BEFORE
 * the CNAME exists and is expected to fail; it is reported and skipped rather
 * than aborting, and re-running the script once DNS has propagated completes
 * it.
 *
 * @param {Object} zone Pull zone record.
 * @param {string} hostname Hostname to attach.
 * @returns {Promise<void>} Resolves once attached, certificate or not.
 */
async function ensureHostname(zone, hostname) {
  const already = (zone.Hostnames || []).some((h) => h.Value === hostname);
  if (!already) {
    await api("POST", `/pullzone/${zone.Id}/addHostname`, { Hostname: hostname });
    console.log(`  hostname ${hostname} added`);
  }
  try {
    await api("GET", `/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(hostname)}`);
    await api("POST", `/pullzone/${zone.Id}/setForceSSL`, { Hostname: hostname, ForceSSL: true });
    console.log(`  ${hostname} has a certificate and forces HTTPS`);
  } catch (error) {
    console.log(`  ${hostname} has no certificate yet: ${error.message.slice(0, 120)}`);
    console.log("  point the CNAME at the pull zone, then run this script again.");
  }
}

/**
 * Run the install.
 *
 * @returns {Promise<void>} Resolves when the install is complete.
 */
async function main() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`missing environment: ${missing.join(", ")}`);

  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(join(here, "dist", "edge-router-bunny.js"), "utf8");

  const scriptName = process.env.SCRIPT_NAME || `${process.env.PULL_ZONE_NAME}-norg-router`;
  console.log(`script ${scriptName}`);
  let script = await ensureScript(scriptName);
  await api("POST", `/compute/script/${script.Id}/code`, { Code: code });

  const values = {};
  for (const name of VARIABLE_NAMES) {
    if (process.env[name] !== undefined) values[name] = process.env[name];
  }
  await writeVariables(script, values);
  await writeSecret(script, process.env.NORG_SITE_KEY);
  await api("POST", `/compute/script/${script.Id}/publish`, { Note: "norg edge router" });
  console.log(`  published (script id ${script.Id})`);

  console.log(`pull zone ${process.env.PULL_ZONE_NAME}`);
  let zone = await ensurePullZone(process.env.PULL_ZONE_NAME, process.env.ORIGIN_URL);
  await configurePullZone(zone, script.Id, process.env.ORIGIN_URL);
  await warnIfOriginIsCacheable(process.env.ORIGIN_URL);
  if (process.env.EDGE_HOSTNAME) await ensureHostname(zone, process.env.EDGE_HOSTNAME);

  zone = await api("GET", `/pullzone/${zone.Id}`);
  const system = (zone.Hostnames || []).find((h) => h.IsSystemHostname);
  console.log(`  zone id ${zone.Id}, cache override ${zone.CacheControlMaxAgeOverride}`);
  console.log(`\nPoint the customer hostname at: ${system ? system.Value : "(unknown)"}`);
  console.log("  CNAME must be DNS-only — a proxying DNS provider hides Bunny's AutoSSL check.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
