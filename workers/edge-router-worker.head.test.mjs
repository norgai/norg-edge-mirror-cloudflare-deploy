/**
 * Edge-router worker — HEAD semantics for NORG-owned paths.
 *
 * isPassthrough dropped every non-GET method (bar MCP POST) straight to the
 * origin. The discovery artifacts, MCP descriptors, reserved /.norg/ assets and
 * the OpenAI feed exist ONLY in NORG's R2, so a HEAD to any of them hit the
 * customer origin and 404'd while the same URL answered 200 to GET — observed
 * on www.foxx.ai for /llms.txt, /tree.json, /graph.jsonld and /agents.md alike.
 * A client that probes with HEAD before fetching concluded every artifact was
 * missing.
 *
 * RFC 9110: HEAD is GET without a body, and its headers must match what GET
 * would send. These tests pin both halves — the status/headers now agree with
 * GET, the body is gone — and the boundary that keeps a HEAD to a CUSTOMER page
 * passing through untouched.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

let moduleCounter = 0;
let worker;

async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?head=${moduleCounter}`);
  return mod.default;
}

const env = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://r2.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
};

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";

let calls;
let waitUntilTasks;
const ctx = {
  waitUntil: (p) => {
    waitUntilTasks.push(p);
  },
};

async function drain() {
  await Promise.allSettled(waitUntilTasks);
}

/** The bot-feed cache the worker reads before classification. */
class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(request) {
    const body = this.store.get(request.url);
    if (body === undefined) return undefined;
    return { json: async () => JSON.parse(body) };
  }
  async put(request, response) {
    this.store.set(request.url, await response.text());
  }
  async delete(request) {
    return this.store.delete(request.url);
  }
}

/** Origin answers a hard 404 for paths that only exist in NORG's R2. */
function installFetch({ norgBody = "artifact body", norgStatus = 200 } = {}) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method =
      (typeof input === "string" ? init.method : input.method) || "GET";
    calls.push({ url, method });
    if (url.includes("/api/v1/edge/bot-patterns")) {
      return new Response(
        JSON.stringify({
          patterns: [
            {
              pattern: "gptbot",
              company: "openai",
              purpose: "training",
              serving_policy: "divert",
            },
          ],
          cache_ttl: 3600,
          cidr_ranges: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("r2.norg.test")) {
      return new Response(norgBody, {
        status: norgStatus,
        headers: { "content-type": "text/plain" },
      });
    }
    // The customer origin: these paths are not theirs, so a real 404.
    return new Response("<html>not found</html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  };
}

function req(path, method = "GET", userAgent = BROWSER) {
  return new Request(`https://customer.com${path}`, {
    method,
    headers: { "user-agent": userAgent },
  });
}

const NORG_OWNED = [
  "/llms.txt",
  "/llms-full.txt",
  "/tree.json",
  "/graph.jsonld",
  "/agents.md",
  "/.well-known/mcp.json",
];

beforeEach(async () => {
  calls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  worker = await loadColdIsolate();
});

for (const path of NORG_OWNED) {
  test(`HEAD ${path} answers with the same status as GET`, async () => {
    installFetch();
    const head = await worker.fetch(req(path, "HEAD"), env, ctx);
    await drain();

    calls = [];
    waitUntilTasks = [];
    const get = await worker.fetch(req(path, "GET"), env, ctx);
    await drain();

    assert.equal(
      head.status,
      get.status,
      `${path}: HEAD status must equal GET status`,
    );
    assert.equal(head.status, 200, `${path}: NORG serves this artifact`);
  });

  test(`HEAD ${path} carries no body`, async () => {
    installFetch();
    const response = await worker.fetch(req(path, "HEAD"), env, ctx);
    await drain();
    assert.equal(await response.text(), "", `${path}: HEAD must be bodyless`);
  });
}

test("HEAD on a NORG artifact reports the same edge marker as GET", async () => {
  installFetch();
  const head = await worker.fetch(req("/llms.txt", "HEAD"), env, ctx);
  await drain();
  calls = [];
  waitUntilTasks = [];
  const get = await worker.fetch(req("/llms.txt", "GET"), env, ctx);
  await drain();

  // Headers must match what GET would send, marker included — a client that
  // probes with HEAD has to see the same thing it will get.
  assert.equal(head.headers.get("X-Norg-Edge"), get.headers.get("X-Norg-Edge"));
});

test("a NORG artifact the receptionist does not have still falls back to origin on HEAD", async () => {
  // Boundary: the fallback is unchanged, so a genuinely missing artifact keeps
  // reporting the origin's own answer rather than inventing a 200.
  installFetch({ norgStatus: 404 });
  const response = await worker.fetch(req("/llms.txt", "HEAD"), env, ctx);
  await drain();
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "");
});

test("HEAD on a CUSTOMER page still passes straight through", async () => {
  // Teeth on the scope: only paths this worker owns answer HEAD. A HEAD to the
  // customer's own document belongs to their application, must not be
  // classified, and must write no crawler-visit row.
  installFetch();
  const response = await worker.fetch(
    req("/products/widget/", "HEAD", GPTBOT),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("X-Norg-Edge"), null);
  assert.ok(!calls.find((c) => c.url.includes("/edge/events")));
  assert.ok(!calls.find((c) => c.url.includes("/edge/render-requests")));
});

test("GET still returns a body — the strip is HEAD-only", async () => {
  installFetch({ norgBody: "llms body" });
  const response = await worker.fetch(req("/llms.txt", "GET"), env, ctx);
  await drain();
  assert.equal(await response.text(), "llms body");
});
