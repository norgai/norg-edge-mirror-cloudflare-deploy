/**
 * Deferred background work — the ctx.waitUntil replacement.
 *
 * @description Proves telemetry stays off the critical path and never throws.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  __test_MAX_PENDING,
  __test_reset,
  __test_state,
  defer,
  flushDeferred,
} from "../lambda/lib/deferred.js";

/**
 * Resolve after the microtask queue and timer queue have drained once.
 *
 * @returns {Promise<void>} Resolves on the next macrotask.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a queued task does not run until the flush", async () => {
  __test_reset();
  let ran = false;
  defer(() => {
    ran = true;
  });

  assert.equal(ran, false, "queueing must not start the task");
  assert.equal(__test_state().pending, 1);

  await flushDeferred();
  await tick();
  assert.equal(ran, true);
});

test("a small queue flushes WITHOUT blocking the response", async () => {
  __test_reset();
  let completed = 0;
  // A real timer, so completion cannot happen inside the microtask drain that
  // `await flushDeferred()` yields anyway — the only thing that could make this
  // task finish before the flush returns is the flush awaiting it.
  defer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed += 1;
  });

  await flushDeferred();

  assert.equal(completed, 0, "a short queue must not hold the visitor's response");
  assert.equal(__test_state().pending, 0, "the queue is still drained into flight");
  assert.equal(__test_state().inFlight, 1);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(completed, 1, "and it still completes in the background");
});

test("a full queue BLOCKS, so a backlog is bounded rather than lost", async () => {
  __test_reset();
  let completed = 0;
  for (let i = 0; i < __test_MAX_PENDING; i += 1) {
    defer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      completed += 1;
    });
  }

  await flushDeferred();

  assert.equal(
    completed,
    __test_MAX_PENDING,
    "a full queue must be awaited to completion, not left to a container that may never wake",
  );
});

test("a blocking flush gives up rather than holding the response open", async () => {
  __test_reset();
  for (let i = 0; i < __test_MAX_PENDING; i += 1) {
    defer(() => new Promise(() => {}));
  }

  const startedAt = Date.now();
  await flushDeferred();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 3000, `flush must time out, took ${elapsed}ms`);
});

test("a rejecting task never escapes as an unhandled rejection", async () => {
  __test_reset();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    defer(() => Promise.reject(new Error("control call failed")));
    defer(() => {
      throw new Error("thrown synchronously");
    });
    await flushDeferred();
    await tick();
    await tick();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, [], "an unhandled rejection would 502 the customer's site");
});

test("one failing task does not prevent the others from running", async () => {
  __test_reset();
  let ran = 0;
  defer(() => Promise.reject(new Error("boom")));
  defer(async () => {
    ran += 1;
  });

  await flushDeferred();
  await tick();
  assert.equal(ran, 1);
});

test("flushing an empty queue is a no-op", async () => {
  __test_reset();
  await flushDeferred();
  assert.deepEqual(__test_state(), { pending: 0, inFlight: 0 });
});
