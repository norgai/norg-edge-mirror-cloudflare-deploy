/**
 * Self-referral detection treats a two-label public suffix (com.au, co.uk,
 * co.nz, ...) as part of the registrable domain, so two different .com.au
 * sites are never mistaken for the same site.
 *
 * Run with: node --test workers/referral.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MULTIPART_PUBLIC_SUFFIXES,
  detectCitationReferral,
  registrableDomain,
} from "./lib/referral.mjs";

const CASES = [
  ["selleys.com.au", "selleys.com.au"],
  ["www.selleys.com.au", "selleys.com.au"],
  ["shop.fosroc.com.au", "fosroc.com.au"],
  ["www.bbc.co.uk", "bbc.co.uk"],
  ["example.co.nz", "example.co.nz"],
  ["chatgpt.com", "chatgpt.com"],
  ["www.google.com", "google.com"],
  ["gemini.google.com", "google.com"],
  ["com.au", "com.au"],
];

for (const [host, expected] of CASES) {
  test(`registrable domain of ${host} is ${expected}`, () => {
    assert.equal(registrableDomain(host), expected);
  });
}

test("two different .com.au sites are different registrable domains", () => {
  assert.notEqual(registrableDomain("selleys.com.au"), registrableDomain("fosroc.com.au"));
});

test("the suffix list covers AU, UK and NZ", () => {
  for (const s of ["com.au", "co.uk", "co.nz"]) assert.ok(MULTIPART_PUBLIC_SUFFIXES.includes(s), s);
});

function request(referer) {
  return new Request("https://www.selleys.com.au/products/", { headers: referer ? { referer } : {} });
}

test("a referral from the same .com.au site is a self-referral", () => {
  const url = new URL("https://www.selleys.com.au/products/?utm_source=chatgpt.com");
  assert.equal(detectCitationReferral(request("https://selleys.com.au/"), url, url.hostname), null);
});

test("an AI citation landing on a .com.au site is still detected", () => {
  const url = new URL("https://www.selleys.com.au/products/");
  const hit = detectCitationReferral(request("https://chatgpt.com/"), url, url.hostname);
  assert.equal(hit.citation_source, "chatgpt");
});

test("a Referer from copilot.com is a Copilot citation without any utm_source", () => {
  const url = new URL("https://www.selleys.com.au/products/");
  const hit = detectCitationReferral(request("https://copilot.com/chats/abc"), url, url.hostname);
  assert.equal(hit.citation_source, "copilot");
  assert.equal(hit.citation_category, "ai_assistant");
});
