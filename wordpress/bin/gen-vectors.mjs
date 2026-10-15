#!/usr/bin/env node
/**
 * Generate tests/fixtures/edge-router-vectors.json from the JavaScript reference.
 *
 * The PHP plugin is a port, so its unit tests assert against outputs computed
 * HERE by the real code: the worker's own exports, functions extracted from its
 * source text (for the ones it does not export), workers/lib, and the
 * provider-neutral strip tokenizer the CloudFront/Bunny adapters ship.
 *
 * Usage: node wordpress/bin/gen-vectors.mjs   (CI re-runs it and fails on a diff)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as worker from "../../workers/edge-router-worker.js";
import { classifyRequest, classifyScriptAutomation } from "../../workers/lib/classify.mjs";
import { pathToKeySuffix } from "../../workers/lib/r2-content.mjs";
import { cidrContains, cidrVerdictFor, parseIp } from "../../workers/lib/cidr.mjs";
import { deriveCanonicalUrl } from "../../workers/lib/alternate-format.mjs";
import { detectCitationReferral } from "../../workers/lib/referral.mjs";
import { detectDeviceType } from "../../workers/lib/page-view.mjs";
import { stripHtml, countVisibleWords } from "../tests/reference/core/strip.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(join(here, "../../workers/edge-router-worker.js"), "utf8");

/** Extract one top-level declaration's source text (function or const) by brace matching. */
function extract(kind, name) {
  const start = workerSource.search(new RegExp(`^(?:export )?${kind} ${name}\\b`, "m"));
  if (start === -1) throw new Error(`not found in worker: ${kind} ${name}`);
  const open = workerSource.indexOf(kind === "function" ? "{" : "=", start);
  if (kind === "const") return workerSource.slice(start, workerSource.indexOf(";\n", open) + 1);
  let depth = 0;
  for (let i = open; i < workerSource.length; i += 1) {
    if (workerSource[i] === "{") depth += 1;
    if (workerSource[i] === "}" && --depth === 0) return workerSource.slice(start, i + 1);
  }
  throw new Error(`unbalanced: ${name}`);
}

/** Evaluate worker functions that are not exported, with the constants they read. */
const local = new Function(
  [
    extract("const", "STATIC_ASSET_SUFFIXES"),
    extract("const", "TRADITIONAL_SEARCH_BOTS"),
    extract("function", "isStaticAssetPath"),
    extract("function", "normaliseSkipPath"),
    extract("function", "isTraditionalSearchBot"),
    extract("function", "siblingPageOf"),
    "return { isStaticAssetPath, normaliseSkipPath, isTraditionalSearchBot, siblingPageOf, STATIC_ASSET_SUFFIXES, TRADITIONAL_SEARCH_BOTS };",
  ].join("\n"),
)();

/** Read an array/Set literal's string members from the worker source. */
function listConstant(name) {
  const text = extract("const", name);
  return [...text.slice(text.indexOf("=")).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

const PATHS = [
  "/", "", "/about", "/about/", "/products/v2.0/", "/products/v2.0", "/file.pdf", "/a/b/c",
  "/llms.txt", "/llms-full.txt", "/tree.json", "/graph.jsonld", "/agents.md", "/blog/llms.txt",
  "/mcp", "/mcp.json", "/.well-known/mcp.json", "/products/x/mcp", "/products/x/mcp.json", "/sse", "/x/sse",
  "/mcpx", "/.norg/theme.css", "/.norgx", "/.well-known/ai-plugin.json", "/openapi.json", "/openapi.yaml",
  "/ai", "/ai/", "/ai/products/widget", "/aircraft", "/about/index.md", "/webmcp.js", "/x/index.openai.json",
  "/index.pdf", "/style.CSS", "/v1.2/page", "/.htaccess", "/file.", "/a//b", "/a//b/", "//", "/img.webp",
  "/font.woff2", "/feed", "/feed/", "/feed/atom", "/wp-json/wp/v2/posts", "/wp-admin/admin-ajax.php",
  "/wp-content/uploads/x.jpg", "/wp-login.php", "/sample-page/", "/%E2%9C%93", "/caf%C3%A9/",
];

const UAS = [
  "", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; Google-Extended)",
  "Mozilla/5.0 (compatible; bingbot/2.0)", "Mozilla/5.0 (compatible; YandexBot/3.0)", "Mozilla/5.0 (Applebot/0.1)",
  "curl/8.4.0", "Wget/1.21", "python-requests/2.31", "Python/3.11 aiohttp/3.9", "Python-urllib/3.11", "axios/1.6.0",
  "node-fetch/1.0", "Go-http-client/1.1", "Java/17.0.1", "okhttp/4.9", "Mozilla/5.0 HeadlessChrome/120",
  "Mozilla/5.0 (Macintosh) Chrome/125.0 Safari/537.36", "PerplexityBot/1.0", "DeepSeekBot", "nuclei/2.9",
];

const PATTERNS = [
  { pattern: "gptbot", company: "openai", purpose: "training", serving_policy: "divert" },
  { pattern: "claudebot", company: "anthropic", purpose: "training", serving_policy: "divert" },
  { pattern: "perplexitybot", company: "perplexity", purpose: "search", serving_policy: "never_divert" },
  { pattern: "deepseekbot", company: "deepseek", purpose: "training", serving_policy: "divert_unverified" },
  { pattern: "google-extended", company: "google", purpose: "training" },
];

const CIDR_CASES = [
  ["192.0.2.10", "192.0.2.0/24"], ["192.0.3.10", "192.0.2.0/24"], ["10.0.0.1", "0.0.0.0/0"], ["10.0.0.1", "10.0.0.1"],
  ["10.0.0.1", "10.0.0.1/32"], ["10.0.0.2", "10.0.0.1/32"], ["010.000.000.001", "10.0.0.0/8"], ["256.0.0.1", "0.0.0.0/0"],
  ["1.2.3", "1.2.3.0/24"], ["2001:db8::1", "2001:db8::/32"], ["2001:db9::1", "2001:db8::/32"], ["::ffff:192.0.2.1", "::ffff:192.0.2.0/120"],
  ["::1", "::1/128"], ["::", "::/0"], ["2001:db8::1", "192.0.2.0/24"], ["192.0.2.1", "2001:db8::/32"], ["fe80::1%eth0", "fe80::/10"],
  ["2001:db8:0:0:0:0:0:1", "2001:db8::/33"], ["2001:db8::1", "2001:db8::/129"], ["192.0.2.1", "192.0.2.0/33"], ["192.0.2.1", "192.0.2.0/x"],
  ["192.0.2.1", "192.0.2.0/24/1"], ["192.0.2.1", "192.0.2.0/"], ["1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:0/112"], ["1:2:3:4:5:6:7:8:9", "::/0"],
  ["1::2::3", "::/0"], ["12345::", "::/0"], ["", "0.0.0.0/0"], ["203.0.113.7", "203.0.113.0/99"], ["2001:DB8::ABCD", "2001:db8::/16"],
  ["1.2.3.4", "1.2.3.4/0"], ["128.0.0.1", "128.0.0.0/1"], ["127.255.255.255", "128.0.0.0/1"], ["2001:db8::1", "2001:db8::/3"],
];

const RANGES = {
  openai: { cidrs: ["192.0.2.0/24", "198.51.100.0/24"] },
  anthropic: { cidrs: ["2001:db8::/32"] },
  empty: { cidrs: [] },
  broken: { cidrs: ["203.0.113.0/99"] },
};
const VERDICT_CASES = [
  ["192.0.2.5", "openai"], ["203.0.113.5", "openai"], ["2001:db8::1", "openai"], ["2001:db8::1", "anthropic"],
  ["192.0.2.5", "anthropic"], ["192.0.2.5", "empty"], ["192.0.2.5", "nobody"], ["garbage", "openai"], [null, "openai"],
  ["203.0.113.5", "broken"],
];

const STRIP_DOCS = [
  "<p>Hello <b>world</b></p>",
  "<!doctype html><html lang=\"en\"><head><title>T &amp; x</title><link rel='stylesheet' href='a.css'><meta name=\"description\" content=\"d\"><script>var a='</div>';</script><style>p{}</style></head><body class=\"x\" data-a=1><nav><ul><li>skip</li></ul></nav><main id=\"m\"><h1 style=\"c\">Head</h1><p>Body text <a href=\"/x\" onclick=\"y\">link</a></p></main><footer>foot</footer></body></html>",
  "<div><nav>a<nav>b</nav>c</nav>after</div>",
  "<div><nav>unclosed <p>rest of doc</p></div>",
  "<h5><button type=\"button\"><span>Trending</span></button></h5>",
  "<p title='a\"b' alt=\"x>y\">q</p>",
  "<img src=\"/a.png\" alt=\"\" loading=lazy><br/><input type=text value=x><hr>",
  "<div aria-hidden=\"true\"><p>hidden</p></div><div aria-hidden=\"false\">shown</div><div role=\"navigation\">menu</div>",
  "<!-- comment --><p>after comment</p><!-- unterminated",
  "a < b and c > d <3 <-- arrow",
  "<P CLASS=\"X\">Upper</P><DIV Data-X='1'>case</DIV>",
  "<textarea>raw <b>text</b></textarea><p>x</p>",
  "<svg><g><path d=\"M0\"/></g></svg><canvas></canvas><video src=x></video><p>media gone</p>",
  "<form action=/s><label>L</label><select><option>o</option></select></form><aside>side</aside>",
  "<p>café — naïve   non breaking</p>",
  "<?xml version=\"1.0\"?><p>pi</p>",
  "<div attr = \"spaced\" bare data-k=v>x</div>",
  "<p>unterminated tag <div class=\"x\"",
  "<script src=x></script><noscript><img src=t></noscript><iframe src=y></iframe><p>ok</p>",
  "<link rel=\"preload\" href=\"f\"><link rel=\"canonical\" href=\"c\"><link rel='prefetch' href='p'>",
  "<time datetime=\"2026-01-01\">Jan</time><html lang=en>",
  "<div><p>Nested <span>deep <em>very <strong>deep</strong></em></span></p></div>",
];

const WORDS = [
  "", "   ", "one", "one two  three", "<p>a</p><p>b</p>", "a b", "a b", "tab\tsep\nnew", "<b>x</b>y", "﻿word",
  "café au lait",
];

const CANONICAL = [
  "/en-au/business/index.jsonld", "/about/index.md", "/x/index.json", "/doc.pdf", "/report.csv", "/x/mcp.json",
  "/x/index.openai.json", "/about/", "/about", "/a.b/c", "/page.html",
];

const REFERRALS = [
  ["https://chatgpt.com/", null], ["https://chat.openai.com/c/1", "chatgpt.com"], ["https://www.perplexity.ai/search", null],
  ["https://claude.ai/chat/x", "claude"], ["https://gemini.google.com/app", null], ["https://www.google.com/", null],
  ["https://google.com/search?q=x", "openai"], ["https://mail.google.com/", null], ["https://docs.google.com/", "perplexity"],
  ["https://example.com/page", null], ["https://www.example.com/", "chatgpt.com"], ["https://unknown.test/", "copilot"],
  [null, "Perplexity"], [null, "newsletter"], [null, null], ["not a url", null], ["https://www.bing.com/", null],
  ["https://copilot.microsoft.com/", "copilot.com"], ["https://sub.chatgpt.com/", null],
];

const URL_TARGETS = [
  "/", "/about", "/a b", "/café", "/a\"b<c>d`e{f}g", "/x?y=1", "/x#frag", "/a/./b", "/a/../b", "/a/b/..", "/a/b/.",
  "/../x", "/%2e%2E/x", "/a/%2e/b", "/a\\b", "/%7Euser", "/a%20b", "/A%2fb", "/x^y", "/a|b", "/a//b", "http://h.test/abs/path?q",
  "/✓", "/a'b", "/a[b]",
];

const vectors = {
  generated_by: "wordpress/bin/gen-vectors.mjs",
  worker_version: worker.EDGE_SCRIPT_VERSION,
  constants: {
    TRADITIONAL_SEARCH_BOTS: listConstant("TRADITIONAL_SEARCH_BOTS"),
    STRIP_REMOVE_SELECTORS: listConstant("STRIP_REMOVE_SELECTORS"),
    STRIP_UNWRAP_SELECTORS: listConstant("STRIP_UNWRAP_SELECTORS"),
    STRIP_KEEP_ATTRIBUTES: listConstant("STRIP_KEEP_ATTRIBUTES"),
    SIBLING_ARTIFACT_FILENAMES: listConstant("SIBLING_ARTIFACT_FILENAMES"),
    OPENAI_FEED_PATHS: listConstant("OPENAI_FEED_PATHS"),
    STATIC_ASSET_SUFFIXES: listConstant("STATIC_ASSET_SUFFIXES"),
    STRIP_WORD_FLOOR: Number(/STRIP_WORD_FLOOR = (\d+)/.exec(workerSource)[1]),
    RESERVED_NORG_PREFIX: /RESERVED_NORG_PREFIX = "([^"]+)"/.exec(workerSource)[1],
  },
  paths: PATHS.map((p) => ({
    path: p,
    key_suffix: pathToKeySuffix(p),
    is_discovery: worker.__test_isDiscoveryPath(p),
    is_sibling_artifact: worker.__test_isSiblingArtifactPath(p),
    sibling_page_of: local.siblingPageOf(p),
    is_reserved_norg: worker.__test_isReservedNorgPath(p),
    is_openai_feed: worker.__test_isOpenAiFeedPath(p),
    is_mcp: worker.__test_isMcpPath(p),
    is_static_asset: local.isStaticAssetPath(p),
    is_agentic: worker.__test_isAgenticPath(p, "/ai"),
    normalise_skip: local.normaliseSkipPath(p || "/"),
  })),
  user_agents: UAS.map((ua) => ({
    ua,
    traditional_search: local.isTraditionalSearchBot(ua),
    classify: classifyRequest(ua, PATTERNS),
    automation: classifyScriptAutomation(ua),
  })),
  patterns: PATTERNS,
  cidr_contains: CIDR_CASES.map(([ip, cidr]) => ({ ip, cidr, contains: cidrContains(ip, cidr), parses: parseIp(ip) !== null })),
  cidr_ranges: RANGES,
  cidr_verdict: VERDICT_CASES.map(([ip, company]) => ({ ip, company, verdict: cidrVerdictFor(ip, RANGES, { company }) })),
  strip: STRIP_DOCS.map((html) => ({ html, stripped: stripHtml(html), words: countVisibleWords(stripHtml(html)) })),
  words: WORDS.map((text) => ({ text, words: worker.__test_countVisibleWords(text), core_words: countVisibleWords(text) })),
  canonical: CANONICAL.map((path) => ({ path, url: deriveCanonicalUrl(new URL(`https://shop.test${path}`), path) })),
  referrals: REFERRALS.map(([referer, utm]) => {
    const url = new URL(`https://shop.example.com/p${utm === null ? "" : `?utm_source=${encodeURIComponent(utm)}`}`);
    const request = { headers: new Headers(referer ? { referer } : {}) };
    return { referer, utm, detection: detectCitationReferral(request, url, "shop.example.com") };
  }),
  device_types: ["", "Mozilla/5.0 (iPad)", "Mozilla/5.0 (Linux; Android 13) Mobile", "Mozilla/5.0 (Linux; Android 13)", "Mozilla/5.0 (iPhone)", "Mozilla/5.0 (Windows NT 10.0)", "Tablet PC"].map((ua) => ({ ua, device: detectDeviceType(ua) })),
  pathnames: URL_TARGETS.map((target) => ({
    target,
    pathname: target.startsWith("http") ? new URL(target).pathname : new URL(`http://host.test${target}`).pathname,
  })),
};

const out = join(here, "../tests/fixtures/edge-router-vectors.json");
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${out}: ${Object.keys(vectors).length} sections, worker ${vectors.worker_version}`);
