/**
 * The strip rewriter that replaces HTMLRewriter.
 *
 * @description Behavioural coverage for the token-dense strip fallback.
 *
 * Note these are the first behavioural tests of the strip in this repo. The
 * Cloudflare suites stub HTMLRewriter (lol-html cannot run under `node --test`)
 * and assert only that a selector is present in the list, never what stripping
 * a document actually produces — so there is no reference implementation to
 * diff against locally, and the semantics are pinned here instead.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { countVisibleWords, shouldKeepAttribute, stripHtml } from "../lambda/lib/strip.js";
import { STRIP_REMOVE_SELECTORS } from "../lambda/lib/constants.mjs";

const TAG_SELECTORS = STRIP_REMOVE_SELECTORS.filter((s) => /^[a-z]+$/.test(s));
// `input` is void: it has no closing tag and so no subtree to remove. It is
// covered by the void-element test below instead.
const CONTAINER_SELECTORS = TAG_SELECTORS.filter((tag) => tag !== "input");

for (const tag of CONTAINER_SELECTORS) {
  test(`<${tag}> and its subtree are removed`, () => {
    const html = `<p>keep</p><${tag}><em>gone</em>also gone</${tag}><p>after</p>`;
    const stripped = stripHtml(html);

    assert.equal(stripped.includes("gone"), false, `${tag} content survived`);
    assert.ok(stripped.includes("keep"));
    assert.ok(stripped.includes("after"), `content after </${tag}> was lost`);
  });
}

test("a self-closing or void removed element is dropped without swallowing what follows", () => {
  assert.equal(stripHtml('<p>a</p><input name="q" /><p>b</p>'), "<p>a</p><p>b</p>");
  assert.equal(stripHtml("<p>a</p><input><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(stripHtml('<form><input type="text"></form><p>b</p>'), "<p>b</p>");
});

test("stylesheet, preload and prefetch links go; other links stay", () => {
  const html =
    '<link rel="stylesheet" href="a.css">' +
    '<link rel="preload" href="b.js">' +
    '<link rel="prefetch" href="c.js">' +
    '<link rel="canonical" href="/page">';

  assert.equal(stripHtml(html), '<link rel="canonical" href="/page">');
});

test("role=navigation and aria-hidden=true are removed on any element", () => {
  assert.equal(stripHtml('<div role="navigation">menu</div><p>keep</p>'), "<p>keep</p>");
  assert.equal(stripHtml('<span aria-hidden="true">x</span><p>keep</p>'), "<p>keep</p>");
  // A different value must not match.
  assert.ok(stripHtml('<div role="main">body</div>').includes("body"));
  assert.ok(stripHtml('<span aria-hidden="false">shown</span>').includes("shown"));
});

test("a button is unwrapped but its text survives", () => {
  // The live case this exists for: an accordion toggle wrapping a real label.
  assert.equal(
    stripHtml("<h5><button><span>Trending</span></button></h5>"),
    "<h5><span>Trending</span></h5>",
  );
});

test("only meaningful attributes survive", () => {
  const html =
    '<a href="/x" class="btn" id="a1" style="color:red" onclick="go()" data-track="1" rel="next">go</a>';
  assert.equal(stripHtml(html), '<a href="/x" rel="next">go</a>');
});

test("every kept attribute is actually kept", () => {
  const kept = ["href", "src", "alt", "title", "lang", "datetime", "content", "name", "rel"];
  for (const name of kept) {
    assert.equal(shouldKeepAttribute(name), true);
    assert.ok(stripHtml(`<x ${name}="v">t</x>`).includes(`${name}="v"`), name);
  }
});

test("comments are removed, the doctype is not", () => {
  assert.equal(stripHtml("<!doctype html><p>a</p><!-- secret --><p>b</p>"),
    "<!doctype html><p>a</p><p>b</p>");
});

test("an unterminated comment does not emit the rest of the document", () => {
  assert.equal(stripHtml("<p>a</p><!-- never closed <p>b</p>"), "<p>a</p>");
});

test("script content containing angle brackets does not derail the tokenizer", () => {
  const html = '<p>before</p><script>if (a<b && c>d) { x("</p>"); }</script><p>after</p>';
  const stripped = stripHtml(html);

  assert.equal(stripped, "<p>before</p><p>after</p>");
});

test("no script tag or inline handler can survive a strip", () => {
  const html =
    '<div onclick="steal()"><script>fetch("/x")</script><img src="a.png" onerror="boom()"></div>';
  const stripped = stripHtml(html);

  assert.equal(/<script/i.test(stripped), false);
  assert.equal(/\son[a-z]+=/i.test(stripped), false);
});

test("nesting of the same removed tag is counted, not ended early", () => {
  const html = "<p>keep</p><nav>a<nav>b</nav>c</nav><p>after</p>";
  const stripped = stripHtml(html);

  assert.equal(stripped, "<p>keep</p><p>after</p>");
});

test("an unclosed removed tag suppresses to the end, which the word floor catches", () => {
  const stripped = stripHtml("<p>keep</p><nav>menu<p>swallowed</p>");

  assert.equal(stripped, "<p>keep</p>");
  assert.ok(
    countVisibleWords(stripped) < 120,
    "the documented failure mode must fall below STRIP_WORD_FLOOR so the origin is served",
  );
});

test("tag and attribute matching is case-insensitive", () => {
  assert.equal(stripHtml("<P>a</P><NAV>gone</NAV>"), "<p>a</p>");
  assert.equal(stripHtml('<LINK REL="stylesheet" HREF="a.css">'), "");
  assert.equal(stripHtml('<A HREF="/x" CLASS="c">t</A>'), '<a href="/x">t</a>');
});

test("an attribute value containing a > does not truncate the tag", () => {
  // `&` is escaped on the way out so the value round-trips; `>` needs no
  // escaping inside a quoted attribute value.
  assert.equal(
    stripHtml('<a href="/a?x=1&y=2" title="a > b">t</a>'),
    '<a href="/a?x=1&amp;y=2" title="a > b">t</a>',
  );
});

test("unquoted and valueless attributes are handled", () => {
  assert.equal(stripHtml("<a href=/x rel=next hidden>t</a>"), '<a href="/x" rel="next">t</a>');
});

test("a literal < in text is not treated as markup", () => {
  assert.equal(stripHtml("<p>1 < 2 and 3 > 2</p>"), "<p>1 < 2 and 3 > 2</p>");
});

test("stripping is idempotent", () => {
  const html =
    '<!doctype html><html><head><title>T</title><style>.a{}</style></head>' +
    '<body><nav>n</nav><h1 class="x">Hi</h1><p>Body <a href="/y">link</a></p>' +
    "<button>Label</button><footer>f</footer></body></html>";
  const once = stripHtml(html);

  assert.equal(stripHtml(once), once);
});

test("title text survives even though title is a raw-text element", () => {
  assert.ok(stripHtml("<head><title>Widgets for sale</title></head>").includes("Widgets for sale"));
});

test("countVisibleWords counts the strip-floor words (empty -> 0)", () => {
  // Same cases the Cloudflare suite asserts, so the floor decision matches.
  assert.equal(countVisibleWords("<p>one two three</p>"), 3);
  assert.equal(countVisibleWords("<div></div>"), 0);
  assert.equal(countVisibleWords(""), 0);
});

test("an empty or text-only document is handled", () => {
  assert.equal(stripHtml(""), "");
  assert.equal(stripHtml("just text"), "just text");
});
