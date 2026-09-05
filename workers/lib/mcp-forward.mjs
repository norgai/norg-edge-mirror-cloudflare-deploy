/**
 * The request headers an MCP forward may carry to NORG.
 *
 * `POST /mcp` (and `/sse`, `/.well-known/mcp.json`) is the one path where the
 * worker relays a visitor's request to NORG rather than answering from a
 * pre-rendered object. It used to copy the inbound header set wholesale, so a
 * Cookie or Authorization header a browser sent to the customer's domain
 * reached NORG. Nothing NORG-side ever read them, but "the worker never
 * transmits your cookies" is a promise a security reviewer will test, so the
 * forward is allowlist-only: what JSON-RPC over streamable HTTP actually needs,
 * plus the user agent NORG's MCP analytics already record. Everything else —
 * cookies, authorization, x-forwarded-*, cf-*, host — is dropped by
 * construction rather than by enumeration.
 */

export const MCP_FORWARD_HEADER_ALLOWLIST = Object.freeze([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

/**
 * Build the header set for an MCP forward from an inbound request's headers.
 *
 * Callers add NORG's own site id/key/page headers to the result; this function
 * deliberately knows nothing about them.
 *
 * @param {?Headers} source Inbound request headers (anything with `.get`).
 * @returns {Headers} A fresh Headers carrying only allowlisted entries.
 */
export function mcpForwardHeaders(source) {
  const out = new Headers();
  if (!source || typeof source.get !== "function") return out;
  for (const name of MCP_FORWARD_HEADER_ALLOWLIST) {
    const value = source.get(name);
    if (value !== null && value !== undefined) out.set(name, value);
  }
  return out;
}
