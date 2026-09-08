/**
 * The viewer-request cache-key stamp.
 *
 * @description Proves the "agent" bucket is a superset of what the router diverts.
 *
 * The one property that matters: any user-agent the router could divert must be
 * stamped "1" here. A false "1" costs a cache variant; a false "0" lets an
 * agent be served a human's cached page while the router never runs, and the
 * feature fails silently. These tests are written from that asymmetry.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyAgent, mayDivert } from "../../core/agent.js";

const functionPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "functions",
  "viewer-classifier.js",
);
const source = readFileSync(functionPath, "utf8");

// CloudFront Functions are plain scripts with a global `handler`, not modules.
const handler = new Function(`${source}\nreturn handler;`)();

/**
 * Build a CloudFront Functions viewer-request event.
 *
 * Note the header shape differs from Lambda@Edge: {name: {value}}, not
 * {name: [{key, value}]}.
 *
 * @param {Object} options User-agent, extra headers and query string.
 * @returns {Object} Event object.
 */
function viewerEvent({ userAgent, headers = {}, querystring = {} } = {}) {
  const eventHeaders = {};
  if (userAgent !== undefined) eventHeaders["user-agent"] = { value: userAgent };
  for (const [key, value] of Object.entries(headers)) eventHeaders[key] = { value };
  return { request: { uri: "/widgets/", headers: eventHeaders, querystring } };
}

/**
 * Stamp value the function assigns to a request.
 *
 * @param {Object} options Passed to viewerEvent.
 * @returns {string} The x-norg-agent value.
 */
const stamp = (options) => handler(viewerEvent(options)).headers["x-norg-agent"].value;

// Real user-agents published by the crawlers this product exists to serve.
const AGENT_USER_AGENTS = [
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
  "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
  "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "Mozilla/5.0 (compatible; Claude-Web/1.0; +https://www.anthropic.com)",
  "Mozilla/5.0 (compatible; anthropic-ai/1.0; +https://www.anthropic.com)",
  "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
  "Mozilla/5.0 (compatible; Google-Extended/1.0)",
  "Mozilla/5.0 (compatible; Applebot-Extended/0.1; +http://www.apple.com/go/applebot)",
  "Mozilla/5.0 (compatible; meta-externalagent/1.1)",
  "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
  "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/amazonbot)",
  "Mozilla/5.0 (compatible; cohere-ai/1.0)",
  "Mozilla/5.0 (compatible; DuckAssistBot/1.0)",
  "Mozilla/5.0 (compatible; YouBot/1.0)",
  "Mozilla/5.0 (compatible; CCBot/2.0; +https://commoncrawl.org/faq/)",
  "Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)",
  "facebookexternalhit/1.1",
  "Twitterbot/1.0",
  "LinkedInBot/1.0",
  "Slackbot-LinkExpanding 1.0",
  "Discordbot/2.0",
  "TelegramBot (like TwitterBot)",
  "WhatsApp/2.19.81 A",
];

// Scripted clients classifyScriptAutomation identifies.
const AUTOMATION_USER_AGENTS = [
  "curl/8.4.0",
  "Wget/1.21.3",
  "python-requests/2.31.0",
  "Python/3.11 aiohttp/3.9.1",
  "Go-http-client/2.0",
  "Java/17.0.8",
  "okhttp/4.12.0",
  "axios/1.6.2",
  "node-fetch/1.0",
  "PostmanRuntime/7.36.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36",
  "Scrapy/2.11.0 (+https://scrapy.org)",
];

// Ordinary browsers, which are the only thing that may take the human bucket.
const BROWSER_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0",
];

for (const userAgent of [...AGENT_USER_AGENTS, ...AUTOMATION_USER_AGENTS]) {
  test(`stamped as an agent: ${userAgent.slice(0, 52)}`, () => {
    assert.equal(
      stamp({ userAgent }),
      "1",
      "a false human stamp lets this be served a cached human page",
    );
  });
}

for (const userAgent of BROWSER_USER_AGENTS) {
  test(`stamped as human: ${userAgent.slice(0, 52)}`, () => {
    assert.equal(stamp({ userAgent }), "0");
  });
}

test("the agent bucket is a SUPERSET of everything the router would divert", () => {
  // Drive the router's own classifier over the same corpus with a feed that
  // authorises every one of them, and check the stamp agrees. This is the
  // property, stated directly rather than inferred from the cases above.
  const patterns = [
    "gptbot", "oai-searchbot", "chatgpt-user", "claudebot", "claude-web",
    "anthropic-ai", "perplexitybot", "perplexity-user", "google-extended",
    "applebot-extended", "meta-externalagent", "bytespider", "amazonbot",
    "cohere-ai", "duckassistbot", "youbot", "ccbot", "diffbot",
    "facebookexternalhit", "twitterbot", "linkedinbot", "slackbot",
    "discordbot", "telegrambot", "whatsapp",
  ].map((pattern) => ({ pattern, company: pattern, purpose: "training", serving_policy: "divert" }));

  for (const userAgent of AGENT_USER_AGENTS) {
    const classification = classifyAgent(userAgent, patterns);
    if (!classification.is_ai_bot || !mayDivert(classification)) continue;
    assert.equal(
      stamp({ userAgent }),
      "1",
      `the router would divert "${userAgent}" but the stamp says human`,
    );
  }
});

test("an absent or empty user-agent takes the agent bucket", () => {
  assert.equal(stamp({}), "1", "scripted clients routinely omit the header");
  assert.equal(stamp({ userAgent: "" }), "1");
});

test("?agent=true never shares a human's cache entry", () => {
  const event = viewerEvent({
    userAgent: BROWSER_USER_AGENTS[0],
    querystring: { agent: { value: "true" } },
  });
  assert.equal(handler(event).headers["x-norg-agent"].value, "1");
});

test("only the exact literal true triggers the override bucket", () => {
  for (const value of ["false", "TRUE", "1", ""]) {
    const event = viewerEvent({
      userAgent: BROWSER_USER_AGENTS[0],
      querystring: { agent: { value } },
    });
    assert.equal(handler(event).headers["x-norg-agent"].value, "0", `?agent=${value}`);
  }
});

test("a health probe gets its own bucket", () => {
  assert.equal(
    stamp({ userAgent: BROWSER_USER_AGENTS[0], headers: { "x-norg-edge-check": "key" } }),
    "probe",
    "a probe response must never collide with a real page's cache entry",
  );
});

test("the function stays under the 10 KB CloudFront Functions limit", () => {
  assert.ok(Buffer.byteLength(source) < 10 * 1024, `${Buffer.byteLength(source)} bytes`);
});

test("the function runs with no fetch, timers or promises available", () => {
  // Grepping the source for "fetch" is unreliable — the marker list contains
  // "http://" and "node-fetch" as data. Shadowing the globals and running it
  // proves the stronger thing directly: the function cannot be using them.
  const sandboxed = new Function(
    "fetch",
    "setTimeout",
    "setInterval",
    "Promise",
    "XMLHttpRequest",
    `${source}\nreturn handler;`,
  )(undefined, undefined, undefined, undefined, undefined);

  const result = sandboxed(viewerEvent({ userAgent: "curl/8.4.0" }));

  assert.equal(result.headers["x-norg-agent"].value, "1");
  assert.equal(typeof result.then, "undefined", "the handler must be synchronous");
});
