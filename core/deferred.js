/**
 * Background work, replacing Cloudflare's `ctx.waitUntil`.
 *
 * @description Runs telemetry off the visitor's path wherever the host allows.
 *
 * The Cloudflare worker runs every control call — visit events, render
 * requests, heartbeats, feed refreshes — through `ctx.waitUntil`, and the
 * runtime holds itself open until that promise settles. Nothing else NORG
 * deploys to gives that for free, so this module is the substitute, and every
 * non-Cloudflare adapter routes its background work through it.
 *
 * TWO RULES, AND BOTH WERE ONCE WRONG.
 *
 * 1. The flush AWAITS SETTLEMENT. It used to start the queued tasks and return
 *    immediately unless the queue was full or stale, on the theory that the
 *    work would finish behind the response. Nothing on any of these runtimes
 *    makes that true. Fastly and Bunny hand this promise straight to their own
 *    `waitUntil`, and a promise that resolves early tells the platform there is
 *    nothing left to wait for, so the runtime tears down mid-flight.
 *    Lambda@Edge freezes the instant the handler returns: an unsettled fetch is
 *    suspended, and by the time another request thaws the container its abort
 *    signal has already expired in wall-clock time, so the call dies with a
 *    TimeoutError it never had the chance to avoid.
 *
 * 2. The work STARTS AT `defer`, not at the flush. Queueing thunks and starting
 *    them at the end meant the telemetry POST began only after the pipeline had
 *    finished every one of its own network calls — so on a host with no
 *    keep-alive the visitor waited for the whole of it, in series. Started at
 *    the point of deferral it instead overlaps the mirror fetch that follows,
 *    and by the time the flush runs it has almost always already landed. The
 *    flush is then a backstop, not a cost.
 *
 * Measured on a live CloudFront install before this: 190 visit rows for the
 * domain, every one written by NORG's own receptionist on a mirror fetch, and
 * not one event from the router in the entire history of the install. The logs
 * showed the shape exactly — `norg edge control call failed
 * /api/v1/edge/events [TimeoutError]` against an endpoint answering in 125 ms.
 *
 * What this still cannot promise is delivery. A budget can expire and a
 * container can vanish; NORG's server-side render dedup, not this module,
 * remains authoritative.
 */

import {
  DEFERRED_FLUSH_BUDGET_MS,
  DEFERRED_SWEEP_BUDGET_MS,
} from "./constants.mjs";

let inFlight = [];

/**
 * Start background work that the visitor's response must not wait on.
 *
 * The task begins now and its rejection handler is attached in the same turn,
 * so there is never a window in which a failure could surface as an unhandled
 * rejection — which on Lambda can fail the whole invocation, and on
 * origin-request means a 502 on the customer's site.
 *
 * There is deliberately no cap on how much may be in flight. Every adapter
 * flushes at the end of every invocation, and one invocation defers a handful
 * of tasks at most, so this has no path to growing. A cap could only discard
 * telemetry that was already on its way.
 *
 * @param {function(): Promise<*>} task Thunk performing the work.
 * @returns {void}
 */
export function defer(task) {
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
}

/**
 * Wait, within a budget, for outstanding background work to settle.
 *
 * Call this immediately before returning, on every exit path including the
 * error one. On Fastly and Bunny the returned promise goes to the platform's
 * `waitUntil` and is awaited after the response has been sent, so the visitor
 * feels none of it. On Lambda@Edge, which has no keep-alive at all, it is
 * awaited inside the invocation — the only moment the work can land — and since
 * passthrough events are off by default there is nothing outstanding on a human
 * request, so only agent traffic can ever pay for it.
 *
 * @param {Object} [options] Flush options.
 * @param {number} [options.budgetMs] Milliseconds to wait for settlement.
 * @returns {Promise<void>} Settles when the work does, or when the budget ends.
 */
export async function flushDeferred({
  budgetMs = DEFERRED_FLUSH_BUDGET_MS,
} = {}) {
  const outstanding = inFlight.filter((entry) => entry.settled !== true);
  inFlight = outstanding;
  if (outstanding.length === 0) return;

  // Returning before these settle is the whole bug this module used to have:
  // it told a keep-alive host there was nothing to wait for, and left a frozen
  // one holding a fetch it would never get back to. See the note above.
  await Promise.race([
    Promise.allSettled(outstanding.map((entry) => entry.promise)),
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);
}

/**
 * Clear a previous invocation's leftovers on a much tighter budget.
 *
 * Separate from `flushDeferred` because the two have different victims: this
 * one runs at the start of an invocation that did not create the work, so on a
 * host without keep-alive it can delay an unrelated visitor. Normally nothing
 * is outstanding and it returns at once.
 *
 * @returns {Promise<void>} Settles when the leftovers do, or the budget ends.
 */
export async function sweepDeferred() {
  return flushDeferred({ budgetMs: DEFERRED_SWEEP_BUDGET_MS });
}

export function __test_reset() {
  inFlight = [];
}

/**
 * Inspect queue state. Test-only.
 *
 * @returns {Object} Counts of outstanding and total recorded tasks.
 */
export function __test_state() {
  return {
    pending: inFlight.filter((entry) => entry.settled !== true).length,
    inFlight: inFlight.length,
  };
}
