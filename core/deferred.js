/**
 * Background work, replacing Cloudflare's `ctx.waitUntil`.
 *
 * @description Defers telemetry off the visitor's critical path on Lambda@Edge.
 *
 * The Cloudflare worker runs every control call — visit events, render
 * requests, heartbeats, feed refreshes — through `ctx.waitUntil`, so the
 * visitor's response never waits on NORG. Lambda@Edge has no equivalent: the
 * execution environment is FROZEN the moment the handler returns, and an
 * unsettled promise simply stops mid-flight.
 *
 * Two properties of Lambda make a decent substitute possible:
 *
 *  1. A frozen environment is thawed, not destroyed, when the same container
 *     serves another request — a promise left in flight resumes then. So work
 *     started and not awaited is not lost so much as SUSPENDED, and flushing at
 *     the START of the next invocation gives it a full request's worth of event
 *     loop to finish in.
 *  2. Every branch that defers work is already about to await a network call of
 *     its own, so deferred tasks make real progress inside the same invocation.
 *
 * What this cannot promise is delivery: a container that is never invoked again
 * drops whatever it was holding. That is why the queue is flushed with an await
 * once it is old or full — bounding loss to a window rather than eliminating
 * it — and why NORG's server-side render dedup, not this queue, remains
 * authoritative.
 */

// Beyond this the queue is flushed synchronously: a container holding a large
// backlog is one whose deferred work is not keeping up, and dropping it
// silently would lose more than the latency costs.
const MAX_PENDING = 25;

// A task older than this has already missed its window; flush and be done.
const MAX_PENDING_AGE_MS = 30 * 1000;

// Hard cap on how long a flush may hold the visitor's response.
const FLUSH_AWAIT_TIMEOUT_MS = 1500;

let pending = [];
let inFlight = [];

/**
 * Queue background work to run outside the visitor's critical path.
 *
 * The task is a thunk rather than a promise so nothing starts until the flush,
 * which keeps ordering predictable and avoids an unhandled rejection between
 * queueing and flushing.
 *
 * @param {function(): Promise<*>} task Thunk performing the work.
 * @returns {void}
 */
export function defer(task) {
  pending.push({ task, queuedAt: Date.now() });
}

/**
 * Should the next flush block the response rather than run behind it?
 *
 * @returns {boolean} True when the queue is full or has waited too long.
 */
function mustAwaitFlush() {
  if (pending.length >= MAX_PENDING) return true;
  const oldest = pending[0];
  return Boolean(oldest && Date.now() - oldest.queuedAt > MAX_PENDING_AGE_MS);
}

/**
 * Start every queued task, and await them only when the queue demands it.
 *
 * Call this BOTH at the start of an invocation and again just before returning.
 * The two calls do different jobs, and only having both makes the queue safe:
 *
 *  - The start call gives work suspended when this container last froze a full
 *    request's worth of event loop to finish in.
 *  - The end call STARTS the work this invocation queued. That matters because
 *    an unstarted thunk can only ever run on a later invocation, whereas a
 *    promise already in flight suspends and resumes on the next thaw — so a
 *    container that serves one request and is never reused still gets its
 *    telemetry away, instead of dropping all of it.
 *
 * Rejections are swallowed. Telemetry must never affect what the visitor sees,
 * and an unhandled rejection in Lambda can fail the whole invocation — which
 * on origin-request means a 502 on the customer's site.
 *
 * @returns {Promise<void>} Resolves once any blocking flush has finished.
 */
export async function flushDeferred() {
  // Promises still running from a previous invocation get an event-loop turn
  // here whether or not anything new was queued.
  inFlight = inFlight.filter((entry) => entry.settled !== true);

  if (pending.length === 0) return;

  const blocking = mustAwaitFlush();
  const batch = pending;
  pending = [];

  const started = batch.map(({ task }) => {
    const entry = { settled: false };
    entry.promise = Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error("norg edge deferred task failed", error);
      })
      .finally(() => {
        entry.settled = true;
      });
    inFlight.push(entry);
    return entry.promise;
  });

  if (!blocking) return;

  await Promise.race([
    Promise.allSettled(started),
    new Promise((resolve) => setTimeout(resolve, FLUSH_AWAIT_TIMEOUT_MS)),
  ]);
}

/**
 * Reset queue state. Test-only.
 *
 * @returns {void}
 */
export function __test_reset() {
  pending = [];
  inFlight = [];
}

/**
 * Inspect queue state. Test-only.
 *
 * @returns {Object} Counts of pending and in-flight tasks.
 */
export function __test_state() {
  return { pending: pending.length, inFlight: inFlight.length };
}

export {
  MAX_PENDING as __test_MAX_PENDING,
  MAX_PENDING_AGE_MS as __test_MAX_PENDING_AGE_MS,
};
