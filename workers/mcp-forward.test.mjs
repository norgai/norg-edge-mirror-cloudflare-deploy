/**
 * lib/mcp-forward.mjs — the MCP forward carries only what JSON-RPC needs.
 *
 * Run with: node --test workers/mcp-forward.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MCP_FORWARD_HEADER_ALLOWLIST, mcpForwardHeaders } from "./lib/mcp-forward.mjs";

test("credentials and hop-by-hop context are dropped; JSON-RPC headers survive", () => {
  const inbound = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Accept-Language": "en-AU",
    "User-Agent": "Mozilla/5.0",
    "Mcp-Session-Id": "sess-1",
    "MCP-Protocol-Version": "2025-06-18",
    "Last-Event-ID": "42",
    Cookie: "session=secret",
    Authorization: "Bearer customer-token",
    "X-Forwarded-For": "198.51.100.9",
    "CF-Connecting-IP": "198.51.100.9",
    Host: "customer.com",
    "X-Custom-Thing": "no",
  });
  const out = mcpForwardHeaders(inbound);

  assert.equal(out.get("content-type"), "application/json");
  assert.equal(out.get("accept"), "application/json, text/event-stream");
  assert.equal(out.get("accept-language"), "en-AU");
  assert.equal(out.get("user-agent"), "Mozilla/5.0");
  assert.equal(out.get("mcp-session-id"), "sess-1");
  assert.equal(out.get("mcp-protocol-version"), "2025-06-18");
  assert.equal(out.get("last-event-id"), "42");
  for (const name of ["cookie", "authorization", "x-forwarded-for", "cf-connecting-ip", "host", "x-custom-thing"]) {
    assert.equal(out.get(name), null, `${name} must be dropped`);
  }
  assert.equal([...out.keys()].length, MCP_FORWARD_HEADER_ALLOWLIST.length);
});

test("the result is a fresh Headers the caller may mutate without touching the request", () => {
  const inbound = new Headers({ "content-type": "application/json" });
  const out = mcpForwardHeaders(inbound);
  out.set("X-Norg-Site-Id", "site-1");
  assert.equal(inbound.get("x-norg-site-id"), null);
});

test("absent or headerless input yields an empty set rather than throwing", () => {
  assert.equal([...mcpForwardHeaders(null).keys()].length, 0);
  assert.equal([...mcpForwardHeaders(new Headers()).keys()].length, 0);
});

test("the allowlist is frozen and lower-case, so a case-variant cannot slip a header through", () => {
  assert.ok(Object.isFrozen(MCP_FORWARD_HEADER_ALLOWLIST));
  for (const name of MCP_FORWARD_HEADER_ALLOWLIST) assert.equal(name, name.toLowerCase());
  assert.equal(MCP_FORWARD_HEADER_ALLOWLIST.includes("cookie"), false);
  assert.equal(MCP_FORWARD_HEADER_ALLOWLIST.includes("authorization"), false);
});
