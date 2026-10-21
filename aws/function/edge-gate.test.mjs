/**
 * The CloudFront Function that replaces the Lambda router: who goes where.
 *
 * @description Loads edge-gate.core.js with a stub `cf`, exercises every branch.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GATE_PLACEHOLDERS, GATE_SIZE_LIMIT, GATE_VERSION } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "edge-gate.core.js"), "utf8")
  .replace("__SITE_ID__", "site-1").replace("__RECEPTIONIST_HOST__", "edge-content.test")
  .replace("__RECEPTIONIST_ORIGIN_ID__", "norg-receptionist").replace("__CUSTOMER_ORIGIN_ID__", "customer")
  .replace("__GATE_VERSION__", "9.9.9-test");

function load() {
  const calls = [];
  const cf = { createRequestOriginGroup: (g) => calls.push(g), selectRequestOriginById: (id) => calls.push(id) };
  // eslint-disable-next-line no-new-func
  const handler = new Function("cf", `${source}\nreturn handler;`)(cf);
  return { handler, calls };
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot";
const GOOGLE = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function event(uri, ua, extra = {}) {
  return {
    viewer: { ip: "203.0.113.9" },
    request: { method: extra.method || "GET", uri, querystring: extra.querystring || {}, headers: { host: { value: "www.customer.test" }, ...(ua ? { "user-agent": { value: ua } } : {}), ...(extra.headers || {}) } },
  };
}

function untouched(res, calls, uri) {
  assert.equal(calls.length, 0, "origin must not be switched");
  assert.equal(res.uri, uri);
  assert.equal(res.headers["x-norg-gate"], undefined);
}

test("a browser on a page goes to the customer's origin untouched", () => {
  const { handler, calls } = load();
  untouched(handler(event("/about/", CHROME)), calls, "/about/");
});

test("a static file goes to the origin whatever the user agent", () => {
  const { handler, calls } = load();
  for (const uri of ["/app.js", "/img/logo.PNG", "/fonts/a.woff2", "/wp-content/x.css"]) untouched(handler(event(uri, GPTBOT)), calls, uri);
});

test("a traditional search engine goes to the origin, even with ?agent=true", () => {
  const { handler, calls } = load();
  untouched(handler(event("/about/", GOOGLE, { querystring: { agent: { value: "true" } } })), calls, "/about/");
});

test("an AI agent is switched to the receptionist origin group with the viewer's UA and IP", () => {
  const { handler, calls } = load();
  const res = handler(event("/about/", GPTBOT));
  assert.equal(calls.length, 1);
  const group = calls[0];
  assert.deepEqual(group.originIds.map((o) => o.originId), ["norg-receptionist", "customer"]);
  assert.deepEqual(group.originIds[0].originOverrides, { hostHeader: "edge-content.test", sni: "edge-content.test" });
  assert.deepEqual(group.failoverCriteria, { statusCodes: [404] });
  assert.equal(res.uri, "/site-1/about/");
  assert.equal(res.headers["x-norg-gate"].value, "cloudfront");
  assert.equal(res.headers["x-norg-gate-version"].value, "9.9.9-test", "the receptionist learns which build sent the request");
  assert.equal(res.headers["x-norg-ua"].value, GPTBOT);
  assert.equal(res.headers["x-norg-viewer-ip"].value, "203.0.113.9");
});

test("a browser with ?agent=true or a signature header is handed to the receptionist", () => {
  const { handler, calls } = load();
  handler(event("/about/", CHROME, { querystring: { agent: { value: "true" } } }));
  handler(event("/about/", CHROME, { headers: { "signature-agent": { value: "x" } } }));
  assert.equal(calls.length, 2);
});

test("an unknown or empty user agent is handed to the receptionist, which decides", () => {
  const { handler, calls } = load();
  handler(event("/about/", "curl/8.4.0"));
  handler(event("/about/", ""));
  handler(event("/about/", null));
  assert.equal(calls.length, 3);
});

test("NORG-owned surfaces go to the receptionist for everyone, search engines included", () => {
  const { handler, calls } = load();
  for (const uri of ["/llms.txt", "/.well-known/mcp.json", "/products/x/mcp", "/about/index.md", "/.norg/style.css", "/openapi.json"]) handler(event(uri, GOOGLE));
  assert.equal(calls.length, 6);
});

test("the query string survives the URI rewrite and the host header is untouched", () => {
  const { handler } = load();
  const res = handler(event("/p/", GPTBOT, { querystring: { q: { value: "1" } } }));
  assert.equal(res.uri, "/site-1/p/");
  assert.deepEqual(res.querystring, { q: { value: "1" } });
  assert.equal(res.headers.host.value, "www.customer.test");
});

test("an internal error returns the original request rather than failing the visitor", () => {
  const { handler } = load();
  const broken = { viewer: null, request: { uri: null, headers: null } };
  assert.equal(handler(broken), broken.request);
});

test("a non-browser POST to an ordinary path goes to the origin: origin groups never fail a POST over", () => {
  // CloudFront fails over on GET, HEAD and OPTIONS only. A webhook or app POST
  // handed to the receptionist would end at its 404 with no second chance.
  const { handler, calls } = load();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    untouched(handler(event("/webhooks/stripe", "Stripe/1.0 (+https://stripe.com/docs/webhooks)", { method })), calls, "/webhooks/stripe");
  }
  handler(event("/about/", GPTBOT, { method: "HEAD" }));
  assert.equal(calls.length, 1, "HEAD is failover-safe and still handed over");
});

test("a POST to an MCP surface still reaches the receptionist: that transport is JSON-RPC over POST", () => {
  const { handler, calls } = load();
  const res = handler(event("/products/x/mcp", "mcp-client/1.0", { method: "POST" }));
  assert.equal(calls.length, 1);
  assert.equal(res.uri, "/site-1/products/x/mcp");
});

test("the built artifact imports the runtime module first, keeps every placeholder and stays under the gate", () => {
  const built = readFileSync(join(here, "..", "src", "edge-gate.js"), "utf8");
  assert.ok(built.startsWith("import cf from 'cloudfront';"));
  assert.ok(built.length <= GATE_SIZE_LIMIT, `built size ${built.length}`);
  for (const placeholder of GATE_PLACEHOLDERS) assert.ok(built.includes(placeholder), `${placeholder} missing from the artifact`);
  let stripped = built;
  for (const placeholder of GATE_PLACEHOLDERS) stripped = stripped.replaceAll(placeholder, "");
  assert.equal(/__[A-Z_]+__/.test(stripped), false, "an unlisted placeholder would never be substituted");
  assert.equal(built.includes("${"), false, "Fn::Sub would treat \"${\" as a substitution");
  assert.equal(/catch\s*\{/.test(built), false, "CloudFront's runtime rejects an optional catch binding");
  // The artifact is built from THIS source: a core edit without a rebuild
  // would ship stale code while the repo looked correct.
  assert.ok(/GATE_VERSION="__GATE_VERSION__"/.test(built), "run: node aws/build.mjs");
  assert.match(GATE_VERSION, /^\d+\.\d+\.\d+$/);
});
