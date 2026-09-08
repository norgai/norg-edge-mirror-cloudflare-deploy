/**
 * Deferred background work — the ctx.waitUntil replacement.
 *
 * @description Proves telemetry actually lands and never breaks the response.
 *
 * The behaviour under test changed after a live CloudFront install was found to
 * have delivered zero router events over its whole history: the flush used to
 * start its tasks and return, which on a keep-alive host tells the platform
 * there is nothing to wait for and on a frozen one abandons the fetch. So the
 * headline assertion here is the opposite of what it once was — the flush must
 * NOT return before the work settles.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFERRED_FLUSH_BUDGET_MS,
  DEFERRED_SWEEP_BUDGET_MS,
} from "../../core/constants.mjs";
import {
  __test_reset,
  __test_state,
  defer,
  flushDeferred,
  sweepDeferred,
} from "../../core/deferred.js";

/**
 * Resolve after the microtask queue and timer queue have drained once.
 *
 * @returns {Promise<void>} Resolves on the next macrotask.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("work STARTS at the deferral, not at the flush", async () => {
  __test_reset();
  let startedAt = null;
  defer(async () => {
    startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  // Started, so it overlaps whatever the caller does next instead of waiting
  // for the pipeline to finish. That overlap is what keeps the flush cheap on a
  // host with no keep-alive.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(startedAt !== null, "the task must be in flight before any flush");
  assert.equal(__test_state().pending, 1);

  await flushDeferred();
  assert.equal(__test_state().pending, 0);
});

test("the flush is nearly free when the work already landed", async () => {
  __test_reset();
  defer(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  const startedAt = Date.now();
  await flushDeferred();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 50, `a settled task must cost the flush nothing, took ${elapsed}ms`);
});

test("the flush waits for the work, so telemetry is actually delivered", async () => {
  __test_reset();
  let completed = 0;
  // A real timer, so completion cannot happen inside the microtask drain that
  // awaiting the flush would yield anyway. Only the flush awaiting settlement
  // can make this task finish before the flush returns.
  defer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed += 1;
  });

  await flushDeferred();

  assert.equal(
    completed,
    1,
    "returning before the task settles is what lost every CloudFront event",
  );
  assert.deepEqual(__test_state(), { pending: 0, inFlight: 1 });
});

test("every queued task is awaited, not just the first", async () => {
  __test_reset();
  let completed = 0;
  for (let i = 0; i < 8; i += 1) {
    defer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      completed += 1;
    });
  }

  await flushDeferred();

  assert.equal(completed, 8);
});

test("a flush gives up rather than holding the response open forever", async () => {
  __test_reset();
  defer(() => new Promise(() => {}));

  const startedAt = Date.now();
  await flushDeferred();
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed >= DEFERRED_FLUSH_BUDGET_MS - 50,
    `flush must spend its budget before giving up, took ${elapsed}ms`,
  );
  assert.ok(
    elapsed < DEFERRED_FLUSH_BUDGET_MS + 1000,
    `flush must time out, took ${elapsed}ms`,
  );
});

test("the sweep uses a far tighter budget than the flush", async () => {
  __test_reset();
  defer(() => new Promise(() => {}));

  const startedAt = Date.now();
  await sweepDeferred();
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed < DEFERRED_FLUSH_BUDGET_MS / 2,
    `a leftover must not delay an unrelated visitor, took ${elapsed}ms`,
  );
  assert.ok(
    elapsed >= DEFERRED_SWEEP_BUDGET_MS - 50,
    `sweep still gives the work a real chance, took ${elapsed}ms`,
  );
});

test("an empty queue costs a human request nothing", async () => {
  __test_reset();

  const startedAt = Date.now();
  await flushDeferred();
  await sweepDeferred();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 50, `an empty flush must be free, took ${elapsed}ms`);
  assert.deepEqual(__test_state(), { pending: 0, inFlight: 0 });
});

test("nothing is ever discarded, however much is deferred", async () => {
  __test_reset();
  const ran = [];
  for (let i = 0; i < 200; i += 1) {
    defer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ran.push(i);
    });
  }

  assert.equal(__test_state().pending, 200, "a cap here could only lose telemetry");

  await flushDeferred();
  assert.equal(ran.length, 200, "and every one of them is sent");
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
  assert.equal(ran, 1);
});

test("settled work is not re-awaited by a later flush", async () => {
  __test_reset();
  defer(async () => {});
  await flushDeferred();

  await flushDeferred();
  assert.equal(__test_state().inFlight, 0, "a settled entry is released, not retained");
});
