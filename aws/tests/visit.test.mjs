/**
 * The visit header: the one place an agent visit's details leave the router.
 *
 * @description Pins the document shape the receptionist decodes.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { __test_MAX_HEADER_BYTES, viewerAttributes, visitHeader } from "../../core/visit.js";

const BOT = { is_ai_bot: true, bot_name: "gptbot", company: "openai", purpose: "training" };

/**
 * Decode a header value back into its document.
 *
 * @param {string} value Header value.
 * @returns {Object} The document.
 */
const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

test("the header carries the classification, both labels and the viewer geo", () => {
  const request = new Request("https://shop.example.com/widgets/", {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.1)",
      "cloudfront-viewer-country": "AU",
      "cloudfront-viewer-city": "Melbourne",
      "cloudfront-viewer-asn": "13335",
      "cloudfront-viewer-http-version": "2.0",
      "cloudfront-viewer-tls": "TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake",
    },
  });
  const document = decode(visitHeader(request, BOT, "mirror", "stripped"));

  assert.deepEqual(document, {
    user_agent: "Mozilla/5.0 (compatible; GPTBot/1.1)",
    is_ai_bot: true,
    bot_name: "gptbot",
    company: "openai",
    purpose: "training",
    served: "mirror",
    served_on_miss: "stripped",
    ip_country: "AU",
    ip_city: "Melbourne",
    asn: "13335",
    http_protocol: "2.0",
    tls_version: "TLSv1.3",
  });
});

test("absent viewer fields are omitted rather than sent as null", () => {
  const request = new Request("https://shop.example.com/", { headers: { "user-agent": "GPTBot" } });
  const document = decode(visitHeader(request, BOT, "mirror", "origin"));
  for (const field of ["ip_country", "ip_city", "asn", "as_organization", "colo", "http_protocol", "tls_version"]) {
    assert.equal(field in document, false, field);
  }
});

test("the header never exceeds the receptionist's cap, however long the user agent", () => {
  // The user agent is the one field a hostile client sizes.
  const request = new Request("https://shop.example.com/", {
    headers: { "user-agent": "x".repeat(20_000), "cloudfront-viewer-city": "y".repeat(3000) },
  });
  const value = visitHeader(request, BOT, "mirror", "stripped");
  assert.ok(value.length <= __test_MAX_HEADER_BYTES, `${value.length} bytes`);
  assert.equal(decode(value).user_agent.length, 512, "truncated to fit, not dropped");
  assert.equal(decode(value).ip_city.length, 255, "every string field is capped at its column width");
});

test("viewerAttributes keeps the event shape identical across providers", () => {
  const headers = new Headers({ "cloudfront-viewer-tls": "TLSv1.2:X:Y" });
  assert.deepEqual(viewerAttributes(headers), {
    ip_country: null,
    ip_city: null,
    asn: null,
    as_organization: null,
    colo: null,
    http_protocol: null,
    tls_version: "TLSv1.2",
  });
});

test("the visit header is built without Node-only APIs", async () => {
  // core/ runs on Fastly (no Buffer) and Bunny (Deno) as well as Lambda@Edge.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../core/visit.js", import.meta.url), "utf8");
  assert.equal(/\bBuffer\b/.test(source), false, "Buffer is not available on every provider runtime");
});
