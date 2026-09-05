/**
 * lib/cidr.mjs — parsing and family-aware matching.
 *
 * Run with: node --test workers/cidr.test.mjs
 *
 * The verdict contract under test: null means "nothing to measure", a boolean
 * is authoritative. The IPv4-only-set cases pin that today's behaviour is
 * unchanged; the IPv6 cases pin what changes the day an operator publishes v6.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cidrContains, cidrFamily, cidrVerdictFor, parseIp } from "./lib/cidr.mjs";

test("parseIp: IPv4", () => {
  assert.deepEqual(parseIp("203.0.113.7"), { family: 4, value: 0xcb007107n });
  assert.deepEqual(parseIp(" 0.0.0.0 "), { family: 4, value: 0n });
  for (const bad of ["256.0.0.1", "1.2.3", "1.2.3.4.5", "a.b.c.d", "", null, undefined]) {
    assert.equal(parseIp(bad), null, `${bad} must not parse`);
  }
});

test("parseIp: IPv6, compressed, embedded IPv4, and the rejects", () => {
  assert.deepEqual(parseIp("::1"), { family: 6, value: 1n });
  assert.deepEqual(parseIp("::"), { family: 6, value: 0n });
  assert.equal(parseIp("2001:db8::1").value, 0x20010db8000000000000000000000001n);
  assert.equal(parseIp("2001:DB8:0:0:0:0:0:1").value, parseIp("2001:db8::1").value);
  assert.equal(parseIp("::ffff:192.0.2.1").value, 0xffffc0000201n);
  for (const bad of ["1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8", "fe80::1%eth0", "gggg::1", "::ffff:999.0.0.1"]) {
    assert.equal(parseIp(bad), null, `${bad} must not parse`);
  }
});

test("cidrContains: IPv4 boundaries", () => {
  assert.equal(cidrContains("203.0.113.7", "203.0.113.0/24"), true);
  assert.equal(cidrContains("203.0.114.7", "203.0.113.0/24"), false);
  assert.equal(cidrContains("203.0.113.7", "203.0.113.7/32"), true);
  assert.equal(cidrContains("203.0.113.8", "203.0.113.7/32"), false);
  assert.equal(cidrContains("203.0.113.7", "203.0.113.7"), true, "bare address is a /32");
  assert.equal(cidrContains("8.8.8.8", "0.0.0.0/0"), true, "/0 matches everything");
});

test("cidrContains: IPv6 boundaries", () => {
  assert.equal(cidrContains("2001:db8:1::42", "2001:db8:1::/48"), true);
  assert.equal(cidrContains("2001:db8:2::42", "2001:db8:1::/48"), false);
  assert.equal(cidrContains("2001:db8::1", "2001:db8::1/128"), true);
  assert.equal(cidrContains("2001:db8::2", "2001:db8::1/128"), false);
  assert.equal(cidrContains("2001:db8::2", "::/0"), true);
});

test("cidrContains: a family mismatch or malformed block is never a match", () => {
  assert.equal(cidrContains("2001:db8::1", "203.0.113.0/24"), false);
  assert.equal(cidrContains("203.0.113.7", "2001:db8::/32"), false);
  for (const bad of ["203.0.113.0/33", "203.0.113.0/-1", "203.0.113.0/", "203.0.113.0/24/8", "2001:db8::/129", "nonsense/8"]) {
    assert.equal(cidrContains("203.0.113.7", bad), false, `${bad} must not match`);
    assert.equal(cidrContains("2001:db8::1", bad), false, `${bad} must not match`);
  }
});

test("cidrFamily", () => {
  assert.equal(cidrFamily("203.0.113.0/24"), 4);
  assert.equal(cidrFamily("2001:db8::/32"), 6);
  assert.equal(cidrFamily("junk/8"), null);
});

const openai = { company: "openai" };

test("cidrVerdictFor: null when there is nothing to measure", () => {
  const v4only = { openai: { cidrs: ["203.0.113.0/24"] } };
  assert.equal(cidrVerdictFor("203.0.113.7", {}, openai), null, "no set for the operator");
  assert.equal(cidrVerdictFor("203.0.113.7", { openai: { cidrs: [] } }, openai), null, "empty set");
  assert.equal(cidrVerdictFor("203.0.113.7", v4only, { company: "perplexity" }), null, "other operator");
  assert.equal(cidrVerdictFor("not-an-ip", v4only, openai), null, "unparseable client");
  assert.equal(cidrVerdictFor("", v4only, openai), null, "missing client");
  // The load-bearing case: an IPv6 client against an IPv4-only set is
  // unmeasurable, not a mismatch. Today every operator publishes IPv4 only.
  assert.equal(cidrVerdictFor("2001:db8::1", v4only, openai), null);
});

test("cidrVerdictFor: strict booleans within the client's family", () => {
  const dual = { openai: { cidrs: ["203.0.113.0/24", "2001:db8:1::/48"] } };
  assert.equal(cidrVerdictFor("203.0.113.7", dual, openai), true);
  assert.equal(cidrVerdictFor("198.51.100.9", dual, openai), false);
  assert.equal(cidrVerdictFor("2001:db8:1::42", dual, openai), true);
  assert.equal(cidrVerdictFor("2001:db8:2::42", dual, openai), false);
  const v6only = { openai: { cidrs: ["2001:db8:1::/48"] } };
  assert.equal(cidrVerdictFor("203.0.113.7", v6only, openai), null, "IPv4 client, IPv6-only set");
  assert.equal(cidrVerdictFor("2001:db8:1::42", v6only, openai), true);
});

test("cidrVerdictFor: a malformed range can never match, and a broken family fails closed", () => {
  const messy = { openai: { cidrs: ["garbage", "203.0.113.0/99", "2001:db8:1::/48"] } };
  assert.equal(cidrVerdictFor("2001:db8:1::42", messy, openai), true);
  // "203.0.113.0/99" identifies as IPv4, so the operator HAS published that
  // family: the verdict is strict (false), not a fallback (null). A corrupt
  // range must narrow what is served, never widen it.
  assert.equal(cidrVerdictFor("203.0.113.7", messy, openai), false);
  // "garbage" identifies as no family at all and is simply ignored.
  assert.equal(cidrVerdictFor("203.0.113.7", { openai: { cidrs: ["garbage"] } }, openai), null);
});
