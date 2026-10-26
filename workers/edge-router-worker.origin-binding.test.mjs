/**
 * Edge-router worker — ORIGIN Service Binding passthrough (0.15.0).
 *
 * Two set-ups put another Worker in front of the same hostname: a Workers
 * Custom Domain Worker, or a route Worker whose route NORG now owns. From a
 * route Worker a plain fetch(request) reaches the DNS origin and BYPASSES that
 * Worker, so the customer's own logic silently stops running for every visitor
 * the router passes through. When a Service Binding named ORIGIN is bound, every
 * origin-bound hop is handed to that Worker instead.
 *
 * These tests pin: the binding is used on every passthrough path (browser,
 * disabled install, HEAD, unverified agent, the top-level catch), the DNS
 * origin is still used when it is absent, a broken binding degrades to the DNS
 * origin rather than an error page, and the health probe reports the binding.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

let moduleCounter = 0;
let worker;

async function loadColdIsolate() {
  moduleCounter += 1;
  const mod = await import(`./edge-router-worker.js?origin-binding=${moduleCounter}`);
  return mod.default;
}

const REQUEST_HOST = "customer.com";
const HEALTH_HEADER = "x-norg-edge-check";

const baseEnv = {
  SITE_ID: "site-123",
  NORG_API_URL: "https://api.norg.test",
  NORG_CONTENT_BASE: "https://r2.norg.test",
  NORG_SITE_KEY: "nek_live_secret",
};

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120";
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";

let calls;
let bindingCalls;
let waitUntilTasks;
const ctx = { waitUntil: (p) => waitUntilTasks.push(p) };

async function drain() {
  await Promise.allSettled(waitUntilTasks);
}

/** Minimal Cache API stub — the colo cache layer for the feed. */
class FakeCache {
  constructor() {
    this.store = new Map();
  }
  async match(request) {
    const body = this.store.get(request.url);
    return body === undefined ? undefined : { json: async () => JSON.parse(body) };
  }
  async put(request, response) {
    this.store.set(request.url, await response.text());
  }
  async delete(request) {
    return this.store.delete(request.url);
  }
}

/**
 * Global fetch stub: NORG_API_URL paths answer 200 JSON (an entitled feed with
 * GPTBot as a divertable pattern and NO published CIDR ranges, so an agent from
 * any IP is unverified); the request host answers as the DNS origin.
 */
function installFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (typeof input === "string" ? init.method : input.method) || "GET";
    calls.push({ url, method, host: new URL(url).host });
    if (url.startsWith(baseEnv.NORG_API_URL)) {
      return new Response(
        JSON.stringify({
          patterns: [
            { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
          ],
          cache_ttl: 3600,
          cidr_ranges: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("dns-origin", { headers: { "content-type": "text/plain" } });
  };
}

/** A bound Worker standing in for the customer's existing one. */
function boundOrigin() {
  return {
    fetch: async (request) => {
      bindingCalls.push({ url: request.url, method: request.method });
      return new Response("bound", { headers: { "x-test-origin": "binding" } });
    },
  };
}

function req(path, { method = "GET", userAgent = BROWSER, headers = {} } = {}) {
  return new Request(`https://${REQUEST_HOST}${path}`, {
    method,
    headers: { "user-agent": userAgent, ...headers },
  });
}

const dnsOriginCalls = () => calls.filter((c) => c.host === REQUEST_HOST);

beforeEach(async () => {
  calls = [];
  bindingCalls = [];
  waitUntilTasks = [];
  globalThis.caches = { default: new FakeCache() };
  installFetch();
  worker = await loadColdIsolate();
});

test("a browser GET is handed to the ORIGIN binding, never the DNS origin", async () => {
  const env = { ...baseEnv, ORIGIN: boundOrigin() };
  const response = await worker.fetch(req("/products/widget/"), env, ctx);
  await drain();

  assert.equal(response.headers.get("x-test-origin"), "binding");
  assert.equal(await response.text(), "bound");
  assert.equal(bindingCalls.length, 1);
  assert.equal(bindingCalls[0].url, `https://${REQUEST_HOST}/products/widget/`);
  assert.deepEqual(dnsOriginCalls(), [], "no global fetch may reach the request host");
});

test("without ORIGIN the same request goes to the DNS origin via global fetch", async () => {
  const response = await worker.fetch(req("/products/widget/"), baseEnv, ctx);
  await drain();

  assert.equal(await response.text(), "dns-origin");
  assert.equal(response.headers.get("x-test-origin"), null);
  const origin = dnsOriginCalls();
  assert.equal(origin.length, 1);
  assert.equal(origin[0].url, `https://${REQUEST_HOST}/products/widget/`);
});

test("a disabled install (EDGE_DISABLED) still passes through the binding", async () => {
  const env = { ...baseEnv, EDGE_DISABLED: "true", ORIGIN: boundOrigin() };
  const response = await worker.fetch(req("/"), env, ctx);
  await drain();

  assert.equal(response.headers.get("x-test-origin"), "binding");
  assert.equal(bindingCalls.length, 1);
  assert.deepEqual(dnsOriginCalls(), []);
  // Disabled is decided before any NORG call — nothing else may be fetched.
  assert.deepEqual(calls, []);
});

test("HEAD through the binding keeps the headers and strips the body", async () => {
  const env = { ...baseEnv, ORIGIN: boundOrigin() };
  const response = await worker.fetch(req("/about/", { method: "HEAD" }), env, ctx);
  await drain();

  assert.equal(bindingCalls.length, 1);
  assert.equal(bindingCalls[0].method, "HEAD");
  assert.equal(response.headers.get("x-test-origin"), "binding");
  assert.equal(await response.text(), "");
  assert.deepEqual(dnsOriginCalls(), []);
});

test("an unverified GPTBot (no entitled source IP) passes through the binding, not DNS", async () => {
  const env = { ...baseEnv, ORIGIN: boundOrigin() };
  const response = await worker.fetch(
    req("/products/widget/", {
      userAgent: GPTBOT,
      headers: { "cf-connecting-ip": "203.0.113.9" },
    }),
    env,
    ctx,
  );
  await drain();

  assert.equal(response.headers.get("x-test-origin"), "binding");
  assert.equal(bindingCalls.length, 1);
  assert.deepEqual(dnsOriginCalls(), []);
  // The feed WAS consulted (the NORG hop is unchanged by the binding) …
  assert.ok(calls.some((c) => c.url.includes("/api/v1/edge/bot-patterns")));
  // … and an unverified agent is never served the mirror.
  assert.ok(!calls.some((c) => c.host === new URL(baseEnv.NORG_CONTENT_BASE).host));
});

test("the health probe reports origin_binding: true when ORIGIN is bound", async () => {
  const env = { ...baseEnv, ORIGIN: boundOrigin() };
  const response = await worker.fetch(
    req("/", { headers: { [HEALTH_HEADER]: baseEnv.NORG_SITE_KEY } }),
    env,
    ctx,
  );
  const body = await response.json();
  assert.equal(body.origin_binding, true);
  assert.equal(body.version, "0.15.0");
  assert.equal(bindingCalls.length, 0, "a health probe never reaches the origin");
});

test("the health probe reports origin_binding: false without ORIGIN", async () => {
  const response = await worker.fetch(
    req("/", { headers: { [HEALTH_HEADER]: baseEnv.NORG_SITE_KEY } }),
    baseEnv,
    ctx,
  );
  const body = await response.json();
  assert.equal(body.origin_binding, false);
});

test("a thrown handler error degrades to the ORIGIN binding, not the DNS origin", async () => {
  // getBotFeed reads caches.default outside any try — a throwing getter is a
  // deterministic stand-in for "any bug in this worker".
  globalThis.caches = {
    get default() {
      throw new Error("simulated worker bug");
    },
  };
  const env = { ...baseEnv, ORIGIN: boundOrigin() };
  const response = await worker.fetch(req("/products/widget/"), env, ctx);

  assert.equal(response.headers.get("x-test-origin"), "binding");
  assert.equal(bindingCalls.length, 1);
  assert.deepEqual(dnsOriginCalls(), []);
});

test("a binding that throws on the catch path falls back to the DNS origin", async () => {
  // A broken binding must degrade to the origin rather than a 1101.
  globalThis.caches = {
    get default() {
      throw new Error("simulated worker bug");
    },
  };
  const env = {
    ...baseEnv,
    ORIGIN: {
      fetch: async () => {
        throw new Error("binding unavailable");
      },
    },
  };
  const response = await worker.fetch(req("/products/widget/"), env, ctx);

  assert.equal(await response.text(), "dns-origin");
  assert.equal(dnsOriginCalls().length, 1);
});

test("an ORIGIN binding without a fetch method is ignored", async () => {
  // Only a real Service Binding (an object exposing fetch) is honoured; a
  // stray plain-text var named ORIGIN must not break passthrough.
  const env = { ...baseEnv, ORIGIN: "https://not-a-binding.example" };
  const response = await worker.fetch(req("/"), env, ctx);
  await drain();

  assert.equal(await response.text(), "dns-origin");
  assert.equal(dnsOriginCalls().length, 1);
});
