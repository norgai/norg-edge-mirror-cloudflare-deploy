/** Tests for the constant-time comparison used by the health probe. */
import test from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual } from "./lib/constant-time.mjs";

test("equal strings match", async () => {
  assert.equal(await constantTimeEqual("nek_live_abc123", "nek_live_abc123"), true);
});

test("different strings of the same length do not match", async () => {
  assert.equal(await constantTimeEqual("nek_live_abc123", "nek_live_abc124"), false);
});

test("different lengths do not match, including a prefix", async () => {
  assert.equal(await constantTimeEqual("nek_live_abc", "nek_live_abc123"), false);
  assert.equal(await constantTimeEqual("", "x"), false);
});

test("non-ASCII input is handled", async () => {
  assert.equal(await constantTimeEqual("clé-ключ", "clé-ключ"), true);
  assert.equal(await constantTimeEqual("clé-ключ", "cle-ключ"), false);
});
