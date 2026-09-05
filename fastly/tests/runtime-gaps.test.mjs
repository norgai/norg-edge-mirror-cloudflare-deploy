/**
 * Web APIs that Node provides and Fastly's runtime does not.
 *
 * @description Guards the gaps that only appear once the Wasm actually runs.
 *
 * WHY THIS FILE EXISTS. Every other test here runs under `node --test`, where
 * the full web platform is available. Fastly's js-compute runtime implements a
 * deliberate subset, so a core/ call site can pass every unit test and still
 * throw ReferenceError on the first real request. That is not hypothetical: the
 * port shipped with `AbortSignal.timeout()` at three core/ call sites, and
 * because Fastly has no AbortSignal each one threw inside its own try/catch —
 * turning the feed refresh into a permanent "unreachable", so the install never
 * became entitled and passed the entire site through, indistinguishable from
 * not being installed. Twelve green pipeline tests did not see it; the first
 * request through Viceroy did.
 *
 * These tests therefore simulate the ABSENCE of a global rather than its
 * presence. Add a case here whenever core/ starts using a web API that Fastly's
 * runtime does not implement.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { timeoutSignal } from "../../core/http.js";
import { refreshFeed, __test_setFeed } from "../../core/feed.js";

const realAbortSignal = globalThis.AbortSignal;

/**
 * Run `fn` with AbortSignal removed, as it is on Fastly.
 *
 * @param {function(): any} fn Body to run.
 * @returns {any} Whatever fn returns.
 */
async function withoutAbortSignal(fn) {
  // eslint-disable-next-line no-global-assign
  delete globalThis.AbortSignal;
  try {
    return await fn();
  } finally {
    globalThis.AbortSignal = realAbortSignal;
  }
}

/**
 * Minimal install config whose EDGE_FETCH records that it was reached.
 *
 * @param {Array<string>} calls Sink for requested URLs.
 * @returns {Object} Config object.
 */
function makeEnv(calls) {
  return {
    SITE_ID: "site-1",
    NORG_SITE_KEY: "nek_live_testkey",
    NORG_API_URL: "https://api.test.norg.ai",
    NORG_CONTENT_BASE: "https://edge-content.test.norg.ai",
    EDGE_PLATFORM: "fastly",
    EDGE_FETCH: async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ patterns: [], cidr_ranges: {}, cache_ttl: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  };
}

afterEach(() => {
  globalThis.AbortSignal = realAbortSignal;
  __test_setFeed(null);
});

test("timeoutSignal yields a real signal where the runtime has AbortSignal", () => {
  const signal = timeoutSignal(1000);
  assert.ok(
    signal instanceof AbortSignal,
    "on Cloudflare, Lambda@Edge and Vercel the bound must still be a real AbortSignal"
  );
});

test("timeoutSignal degrades to undefined instead of throwing on Fastly", async () => {
  const signal = await withoutAbortSignal(() => timeoutSignal(1000));
  assert.equal(
    signal,
    undefined,
    "fetch ignores an undefined signal; on Fastly the bound comes from the " +
      "per-backend timeouts in fastly.toml instead"
  );
});

test("the feed request is still issued on a runtime with no AbortSignal", async () => {
  const calls = [];
  const env = makeEnv(calls);

  await withoutAbortSignal(() => refreshFeed(env));

  // THE regression assertion. The ReferenceError was raised while EVALUATING
  // the arguments to edgeFetch, so before the fix the request was never issued
  // at all and this array stayed empty.
  //
  // The assertion stops here on purpose. Node's own undici needs AbortSignal to
  // construct a Response, so with the global deleted the stub cannot build a
  // reply and refreshFeed can only ever report "unreachable" — a limit of the
  // harness, not of the code. The outcome is asserted in the next test, which
  // removes only the capability the guard actually probes.
  assert.equal(
    calls.length,
    1,
    "the bot-patterns request must actually be issued, not lost to a " +
      "ReferenceError thrown while building its options"
  );
  assert.match(calls[0], /\/api\/v1\/edge\/bot-patterns$/);
});

test("a runtime without AbortSignal.timeout still produces an entitled feed", async () => {
  const calls = [];
  const env = makeEnv(calls);

  // Exactly the branch timeoutSignal guards on, with the rest of the platform
  // left intact so Response still works.
  const realTimeout = AbortSignal.timeout;
  delete AbortSignal.timeout;
  let result;
  try {
    result = await refreshFeed(env);
  } finally {
    AbortSignal.timeout = realTimeout;
  }

  assert.equal(
    result.outcome,
    "ok",
    "a reachable NORG must produce an entitled feed; 'unreachable' here means " +
      "the install would silently pass the whole site through"
  );
  assert.equal(result.entry.entitled, true);
});
