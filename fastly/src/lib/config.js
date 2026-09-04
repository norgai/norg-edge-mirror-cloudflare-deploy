/**
 * Install configuration, sourced from Fastly's Config and Secret stores.
 *
 * @description Fastly adapter for the provider-neutral config in core/.
 *
 * Fastly gives each of the two values its natural home, and the split is worth
 * keeping deliberate:
 *
 *  - The Config Store holds the plain values (site id, API URLs, flags). Values
 *    are readable through the API, which is correct for configuration.
 *  - The Secret Store holds NORG_SITE_KEY. It is write-only through the API —
 *    plaintext cannot be read back once written, only decrypted at the edge
 *    during request processing. That is a stronger guarantee than Cloudflare's
 *    worker secrets and much stronger than CloudFront, where the key travels as
 *    an origin custom header visible to anyone who can read the distribution.
 *
 * Both stores are read once per request and the result is shaped exactly like
 * the Cloudflare worker's `env`, so everything in core/ reads it unchanged.
 *
 * NOTE the Secret Store's 5-reads-per-request cap: read the key ONCE here, not
 * at each call site.
 */

import { ConfigStore } from "fastly:config-store";
import { SecretStore } from "fastly:secret-store";

/**
 * Version of this artifact, reported on every control call and heartbeat.
 *
 * Versioned independently of the other providers because it is a separate
 * deployable with its own pin; content-craft compares it against
 * EDGE_WORKER_VERSION_FASTLY.
 */
export const EDGE_SCRIPT_VERSION = "0.1.0";

/** Names of the two stores this install expects. */
export const CONFIG_STORE_NAME = "norg_edge_config";
export const SECRET_STORE_NAME = "norg_edge_secrets";

// Config Store key -> binding name. Mirrors build_worker_bindings() in
// content-craft's install_service.py; adding a binding there means adding it
// here. NORG_SITE_KEY is deliberately absent — it lives in the Secret Store.
const CONFIG_KEYS = {
  site_id: "SITE_ID",
  norg_api_url: "NORG_API_URL",
  norg_content_base: "NORG_CONTENT_BASE",
  strip_fallback_enabled: "STRIP_FALLBACK_ENABLED",
  edge_disabled: "EDGE_DISABLED",
  lazy_render_enabled: "LAZY_RENDER_ENABLED",
  edge_env: "EDGE_ENV",
  events_verbose: "EDGE_EVENTS_VERBOSE",
};

/**
 * Read install config from the Config Store and the Secret Store.
 *
 * A missing store is not an error here: an unconfigured install must be inert
 * rather than throwing, so the caller sees an env without credentials and
 * passes every request through (rule 3).
 *
 * @returns {Promise<Object>} Binding-shaped config object.
 */
export async function readConfig() {
  const env = { EDGE_SCRIPT_VERSION, EDGE_PLATFORM: "fastly" };

  try {
    const store = new ConfigStore(CONFIG_STORE_NAME);
    for (const [key, name] of Object.entries(CONFIG_KEYS)) {
      const value = store.get(key);
      if (value !== null && value !== undefined) env[name] = value;
    }
  } catch (e) {
    console.error("norg edge config store unavailable", e);
  }

  try {
    // One read only — the Secret Store allows 5 per request.
    const entry = await new SecretStore(SECRET_STORE_NAME).get("norg_site_key");
    if (entry) env.NORG_SITE_KEY = entry.plaintext();
  } catch (e) {
    console.error("norg edge secret store unavailable", e);
  }

  return env;
}
