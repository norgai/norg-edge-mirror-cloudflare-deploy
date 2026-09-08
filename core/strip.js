/**
 * Strip origin HTML to a token-dense form, replacing Cloudflare's HTMLRewriter.
 *
 * @description Hand-rolled HTML rewriter matching the worker's strip semantics.
 *
 * HTMLRewriter is a Cloudflare runtime primitive with no CloudFront equivalent,
 * so the strip fallback has to be rebuilt. It is deliberately NOT built on a
 * third-party parser: this bundle ships into customers' own AWS accounts, where
 * every dependency is a supply-chain surface they inherit from us, and the
 * repo's build and test steps are zero-install by design.
 *
 * That is affordable because the selector set is tiny and fixed. Every entry in
 * STRIP_REMOVE_SELECTORS is either a bare tag name or a tag plus one
 * attribute-equals test, and STRIP_UNWRAP_SELECTORS is just `button` — no
 * descendant combinators, no classes, no pseudo-selectors. None of that needs a
 * DOM or a CSS engine, only a tokenizer.
 *
 * Where it deliberately differs from a real parser: a removal range ends at the
 * matching close tag OF THE SAME NAME, counted for nesting. Unclosed tags of
 * other names inside the range cannot confuse it, but an unclosed `<nav>` with
 * no `</nav>` anywhere suppresses to the end of the document. That is the one
 * malformed-input failure mode, and it is contained rather than dangerous: the
 * result is a near-empty page, STRIP_WORD_FLOOR rejects it, and the caller
 * serves the untouched origin as "origin_thin" — exactly what it does for a
 * client-rendered page whose content the strip removes.
 */

import {
  STRIP_KEEP_ATTRIBUTES,
  STRIP_REMOVE_SELECTORS,
  STRIP_UNWRAP_SELECTORS,
} from "./constants.mjs";

// Elements that never have a closing tag, so they can never open a range.
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// Elements whose content is text, not markup. A `<` inside them is literal, so
// the tokenizer must skip to the literal close tag rather than parse onwards.
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

/**
 * Compile one selector into a matcher.
 *
 * Handles exactly the two shapes the strip lists use: `tag`, and `tag[attr='v']`
 * or `[attr='v']`.
 *
 * @param {string} selector Selector text.
 * @returns {{tag: ?string, attribute: ?string, value: ?string}} Matcher.
 */
function compileSelector(selector) {
  const match = /^([a-z0-9-]*)(?:\[([a-z-]+)='([^']*)'\])?$/i.exec(selector);
  if (!match) throw new Error(`unsupported strip selector: ${selector}`);
  return {
    tag: match[1] ? match[1].toLowerCase() : null,
    attribute: match[2] ? match[2].toLowerCase() : null,
    value: match[3] ?? null,
  };
}

const REMOVE_MATCHERS = STRIP_REMOVE_SELECTORS.map(compileSelector);
const UNWRAP_TAGS = new Set(STRIP_UNWRAP_SELECTORS.map((tag) => tag.toLowerCase()));

/**
 * Find the index of the `>` closing a tag, ignoring any inside quoted values.
 *
 * @param {string} html Full document.
 * @param {number} start Index of the opening `<`.
 * @returns {number} Index of the closing `>`, or -1 when unterminated.
 */
function findTagEnd(html, start) {
  let quote = "";
  for (let i = start + 1; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Parse the attributes out of a tag's inner text.
 *
 * @param {string} source Tag inner text, after the tag name.
 * @returns {Array<{name: string, value: ?string}>} Attributes in source order.
 */
function parseAttributes(source) {
  const attributes = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match = pattern.exec(source);
  while (match) {
    attributes.push({
      name: match[1].toLowerCase(),
      value: match[2] ?? match[3] ?? match[4] ?? null,
    });
    match = pattern.exec(source);
  }
  return attributes;
}

/**
 * Does this element match the matcher?
 *
 * @param {Object} matcher Compiled selector.
 * @param {string} tag Lower-cased tag name.
 * @param {Array<Object>} attributes Parsed attributes.
 * @returns {boolean} True on a match.
 */
function elementMatches(matcher, tag, attributes) {
  if (matcher.tag && matcher.tag !== tag) return false;
  if (!matcher.attribute) return true;
  return attributes.some(
    (attribute) => attribute.name === matcher.attribute && attribute.value === matcher.value,
  );
}

/**
 * Should this attribute survive stripping?
 *
 * @param {string} name Lower-cased attribute name.
 * @returns {boolean} True when the attribute carries meaning.
 */
export function shouldKeepAttribute(name) {
  return STRIP_KEEP_ATTRIBUTES.has(name);
}

/**
 * Escape a value for a double-quoted attribute.
 *
 * @param {string} value Raw attribute value.
 * @returns {string} Value safe to place between double quotes.
 */
const escapeAttribute = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Re-serialise an open tag, keeping only meaningful attributes.
 *
 * @param {string} tag Lower-cased tag name.
 * @param {Array<Object>} attributes Parsed attributes.
 * @param {boolean} selfClosing Whether the source tag was self-closed.
 * @returns {string} The rewritten tag.
 */
function serialiseOpenTag(tag, attributes, selfClosing) {
  const kept = attributes
    .filter((attribute) => shouldKeepAttribute(attribute.name))
    .map((attribute) =>
      attribute.value === null
        ? ` ${attribute.name}`
        : ` ${attribute.name}="${escapeAttribute(attribute.value)}"`,
    )
    .join("");
  return `<${tag}${kept}${selfClosing ? " /" : ""}>`;
}

/**
 * Index just past the close tag of a raw-text element.
 *
 * @param {string} html Full document.
 * @param {number} from Index to search from.
 * @param {string} tag Lower-cased tag name.
 * @returns {{content: string, next: number}} Interior text and resume index.
 */
function readRawText(html, from, tag) {
  const close = html.toLowerCase().indexOf(`</${tag}`, from);
  if (close === -1) return { content: html.slice(from), next: html.length };
  const end = findTagEnd(html, close);
  return {
    content: html.slice(from, close),
    next: end === -1 ? html.length : end + 1,
  };
}

/**
 * Strip an HTML document to its informational content.
 *
 * @param {string} html Origin HTML.
 * @returns {string} Stripped HTML.
 */
export function stripHtml(html) {
  const out = [];
  const state = { suppressTag: null, depth: 0 };
  let i = 0;

  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open === -1) {
      if (!state.suppressTag) out.push(html.slice(i));
      break;
    }
    if (open > i && !state.suppressTag) out.push(html.slice(i, open));

    const consumed = consumeMarkup(html, open, state, out);
    // A `<` that begins no markup is literal text, not a tag.
    if (consumed === open) {
      if (!state.suppressTag) out.push("<");
      i = open + 1;
    } else {
      i = consumed;
    }
  }

  return out.join("");
}

/**
 * Consume one markup construct at `open`, appending output as appropriate.
 *
 * @param {string} html Full document.
 * @param {number} open Index of `<`.
 * @param {Object} state Mutable suppression state.
 * @param {Array<string>} out Output accumulator.
 * @returns {number} Index to resume from, or `open` when this is literal text.
 */
function consumeMarkup(html, open, state, out) {
  if (html.startsWith("<!--", open)) {
    const end = html.indexOf("-->", open);
    return end === -1 ? html.length : end + 3;
  }
  if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
    const end = findTagEnd(html, open);
    if (end === -1) return html.length;
    if (!state.suppressTag) out.push(html.slice(open, end + 1));
    return end + 1;
  }
  if (html.startsWith("</", open)) return consumeCloseTag(html, open, state, out);
  if (/[a-z]/i.test(html[open + 1] || "")) return consumeOpenTag(html, open, state, out);
  return open;
}

/**
 * Consume a closing tag, ending a suppression range when it matches.
 *
 * @param {string} html Full document.
 * @param {number} open Index of `<`.
 * @param {Object} state Mutable suppression state.
 * @param {Array<string>} out Output accumulator.
 * @returns {number} Index to resume from.
 */
function consumeCloseTag(html, open, state, out) {
  const end = findTagEnd(html, open);
  if (end === -1) return html.length;
  const tag = html.slice(open + 2, end).trim().toLowerCase();

  if (state.suppressTag) {
    if (tag === state.suppressTag) {
      state.depth -= 1;
      if (state.depth === 0) state.suppressTag = null;
    }
    return end + 1;
  }
  if (!UNWRAP_TAGS.has(tag)) out.push(`</${tag}>`);
  return end + 1;
}

/**
 * Consume an opening tag, starting a suppression range when it matches.
 *
 * @param {string} html Full document.
 * @param {number} open Index of `<`.
 * @param {Object} state Mutable suppression state.
 * @param {Array<string>} out Output accumulator.
 * @returns {number} Index to resume from.
 */
function consumeOpenTag(html, open, state, out) {
  const end = findTagEnd(html, open);
  if (end === -1) return html.length;

  const inner = html.slice(open + 1, end);
  const selfClosing = inner.endsWith("/");
  const nameEnd = inner.search(/[\s/]/);
  const tag = (nameEnd === -1 ? inner : inner.slice(0, nameEnd)).toLowerCase();
  const attributes = parseAttributes(nameEnd === -1 ? "" : inner.slice(nameEnd));

  // Inside a removed subtree only nesting of the same tag matters; everything
  // else is discarded wholesale.
  if (state.suppressTag) {
    if (tag === state.suppressTag && !selfClosing && !VOID_ELEMENTS.has(tag)) state.depth += 1;
    return skipRawText(html, end + 1, tag).next;
  }

  const removed = REMOVE_MATCHERS.some((matcher) => elementMatches(matcher, tag, attributes));
  if (removed) {
    if (selfClosing || VOID_ELEMENTS.has(tag)) return end + 1;
    if (RAW_TEXT_ELEMENTS.has(tag)) return readRawText(html, end + 1, tag).next;
    state.suppressTag = tag;
    state.depth = 1;
    return end + 1;
  }

  if (!UNWRAP_TAGS.has(tag)) out.push(serialiseOpenTag(tag, attributes, selfClosing));

  if (RAW_TEXT_ELEMENTS.has(tag) && !selfClosing) {
    const raw = readRawText(html, end + 1, tag);
    out.push(raw.content, `</${tag}>`);
    return raw.next;
  }
  return end + 1;
}

/**
 * Skip a raw-text element's body while suppressed.
 *
 * @param {string} html Full document.
 * @param {number} from Index after the open tag.
 * @param {string} tag Lower-cased tag name.
 * @returns {{next: number}} Resume index.
 */
function skipRawText(html, from, tag) {
  if (!RAW_TEXT_ELEMENTS.has(tag)) return { next: from };
  return { next: readRawText(html, from, tag).next };
}

/**
 * Count visible words in an HTML fragment.
 *
 * Ported verbatim from the Cloudflare worker so the STRIP_WORD_FLOOR decision
 * is made on the same number on both providers.
 *
 * @param {string} html HTML fragment.
 * @returns {number} Whitespace-delimited word count of the tag-free text.
 */
export function countVisibleWords(html) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").length : 0;
}
