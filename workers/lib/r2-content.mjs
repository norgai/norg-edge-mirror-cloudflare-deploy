/**
 * Shared R2 mirror-content addressing for NORG Cloudflare workers.
 *
 * `pathToKeySuffix` is the single source of the URL-path -> R2-key mapping,
 * imported by edge-router-worker.js (customer zones, builds the receptionist
 * fetch URL) and edge-content-proxy-worker.js (NORG zone, builds the actual
 * bucket key). It MUST stay identical to the backend's
 * `app/services/edge_routing/paths.py::r2_key_for()`: a trailing slash always
 * means a directory (even when the segment contains a dot, e.g.
 * /products/v2.0/), extensionless paths get index.html, and anything with an
 * extension is verbatim.
 */

/**
 * Map a request pathname to its R2 key suffix.
 * @param {string} pathname Request pathname.
 * @returns {string} Key suffix beginning with "/".
 */
export function pathToKeySuffix(pathname) {
  if (!pathname || pathname === "/") return "/index.html";
  if (pathname.endsWith("/")) return `${pathname}index.html`;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return lastSegment.includes(".") ? pathname : `${pathname}/index.html`;
}

/**
 * Is this path inside a site's reserved agentic subtree?
 *
 * Matches the prefix itself and anything beneath it, but not a sibling that
 * merely starts with the same characters — "/ai" must not capture "/aircraft".
 * Shared so the alias means the same thing everywhere it's served from: the
 * customer-zone worker (edge-router-worker.js) and the NORG-hosted directory
 * worker (r2-proxy-worker.js) must agree, since a workspace can switch
 * between those two deployment modes.
 *
 * @param {string} pathname Request pathname.
 * @param {?string} prefix Configured prefix, e.g. "/ai" (falsy = disabled).
 * @returns {boolean} True when the path is the prefix or inside it.
 */
export function isAgenticPath(pathname, prefix) {
  if (!prefix) return false;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Read one object from a native R2 bucket binding.
 *
 * Binding-only by design — NO public-URL fallback. The receptionist exists
 * so the bucket never needs public access; silently falling back to a
 * public URL would reintroduce exactly the exposure it removes.
 *
 * @param {Object} bucket R2 bucket binding (env.EDGE_BUCKET).
 * @param {string} key Full object key, no leading slash.
 * @returns {Promise<?{body: ReadableStream, httpEtag: string, contentType: ?string}>}
 *   Object with body/etag/content-type, or null when absent.
 */
export async function readBucketObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return {
    body: object.body,
    httpEtag: object.httpEtag,
    contentType: object.httpMetadata && object.httpMetadata.contentType,
  };
}
