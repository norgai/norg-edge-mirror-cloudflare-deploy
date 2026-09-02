/**
 * Shared alternate-format canonical/noindex header treatment for NORG workers.
 *
 * Single source of truth imported by BOTH r2-proxy-worker.js (NORG zone) and
 * edge-router-worker.js (customer zones), so the two can never diverge (MIRROR
 * 03 AC4). The NORG-zone worker exposes .json/.jsonld/.md/.pdf variants to AI
 * crawlers while keeping them out of Google's index via a cross-format
 * rel=canonical Link (a weak hint) plus X-Robots-Tag: noindex (the
 * authoritative signal — it does not block fetching, so agents still read the
 * variant). /mcp.json, /.well-known/mcp.json and .openai.json are deliberately
 * EXEMPT: an MCP manifest is a discovery resource, not a format variant.
 */

// Non-HTML format extensions that should carry a canonical Link header.
export const ALTERNATE_FORMAT_EXTENSIONS = new Set([
  ".json",
  ".jsonld",
  ".md",
  ".pdf",
  ".csv",
]);

/**
 * Derive the canonical HTML URL for a non-HTML format request.
 *
 * For paths like /en-au/business/index.jsonld, returns the clean directory URL
 * /en-au/business/ which resolves to index.html. Returns null for HTML requests,
 * paths without a recognized extension, and the exempt MCP/openai resources.
 *
 * @param {URL} url - The original request URL (supplies protocol + hostname).
 * @param {string} path - The resolved pathname (may have index.html appended).
 * @returns {string|null} Canonical URL or null if not applicable.
 */
export function deriveCanonicalUrl(url, path) {
  // Only process paths with recognized alternate format extensions
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const ext = path.substring(dotIndex);
  if (!ALTERNATE_FORMAT_EXTENSIONS.has(ext)) return null;

  // Also skip .openai.json (product spec) — it's a separate resource
  if (path.endsWith(".openai.json")) return null;

  // Skip mcp.json — MCP manifest is a per-directory resource, not a format variant
  if (path.endsWith("/mcp.json")) return null;

  // Derive canonical: replace index.{ext} with trailing slash (directory URL)
  // e.g., /en-au/business/index.jsonld → /en-au/business/
  const filename = path.split("/").pop();
  let canonicalPath;
  if (filename.startsWith("index.")) {
    canonicalPath = path.substring(0, path.length - filename.length);
  } else {
    // Non-index files: use clean directory URL (trailing slash)
    canonicalPath = path.substring(0, dotIndex) + "/";
  }

  return `${url.protocol}//${url.hostname}${canonicalPath}`;
}

/**
 * Return `response` with the alternate-format Link + X-Robots-Tag headers when
 * `path` is a non-HTML sibling, otherwise the response unchanged.
 *
 * A weak cross-format rel=canonical plus the authoritative X-Robots-Tag:
 * noindex keeps the machine-readable variants out of Google's index while
 * leaving them fetchable by agents. Exemptions live in deriveCanonicalUrl.
 *
 * @param {Response} response - The response to (possibly) re-header.
 * @param {URL} url - The original request URL.
 * @param {string} path - The resolved pathname used for extension detection.
 * @returns {Response} The same response, or a re-headered copy.
 */
export function withAlternateFormatHeaders(response, url, path) {
  const canonicalUrl = deriveCanonicalUrl(url, path);
  if (!canonicalUrl) return response;
  const headers = new Headers(response.headers);
  headers.set("Link", `<${canonicalUrl}>; rel="canonical"`);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
