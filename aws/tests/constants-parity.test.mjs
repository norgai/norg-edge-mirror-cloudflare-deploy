/**
 * Byte-parity between the Cloudflare worker's constant tables and the AWS copy.
 *
 * @description Fails when a shared constant drifts between the two routers.
 *
 * `aws/lambda/lib/constants.mjs` copies its declarations from
 * `workers/edge-router-worker.js` rather than importing them, because that
 * worker's bundle is SHA-256-pinned by content-craft and editing it would force
 * an EDGE_SCRIPT_VERSION bump (see the header of constants.mjs). This test is
 * what makes the copy safe: change a strip selector, a timeout or the word
 * floor on one side and it fails here, naming the constant.
 *
 * The comparison is on DECLARATION TEXT, not evaluated values, so a reordered
 * array or a changed comment inside a literal is caught too.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cloudflareSource = readFileSync(
  join(repoRoot, "workers", "edge-router-worker.js"),
  "utf8",
);
const awsSource = readFileSync(
  join(repoRoot, "aws", "lambda", "lib", "constants.mjs"),
  "utf8",
);

// Every constant the two routers must agree on. Deliberately excluded:
// RESPONSE_CACHE_KEY_PREFIX / PATTERN_CACHE_KEY / PATTERN_CACHE_RETENTION_SECONDS
// are synthetic keys for Cloudflare's `caches.default`, which has no CloudFront
// equivalent — the AWS router caches in module globals instead.
const SHARED_CONSTANTS = [
  "BINDING_DEFAULTS",
  "RESERVED_NORG_PREFIX",
  "RESERVED_ASSET_CACHE_CONTROL",
  "LOOP_GUARD_HEADER",
  "HEALTH_CHECK_HEADER",
  "MIRROR_FETCH_TIMEOUT_MS",
  "PATTERN_FETCH_TIMEOUT_MS",
  "CONTROL_CALL_TIMEOUT_MS",
  "MCP_FORWARD_TIMEOUT_MS",
  "RESPONSE_CACHE_DEFAULT_TTL_SECONDS",
  "PATTERN_DEFAULT_TTL_MS",
  "UNENTITLED_TTL_MS",
  "HEARTBEAT_MIN_INTERVAL_MS",
  "RENDER_DEDUP_TTL_MS",
  "RENDER_DEDUP_MAX_ENTRIES",
  "STRIP_WORD_FLOOR",
  "TRADITIONAL_SEARCH_BOTS",
  "UNENTITLED",
  "DEFAULT_AGENTIC_PATH_PREFIX",
  "REFUSAL_STATUSES",
  "STRIP_REMOVE_SELECTORS",
  "STRIP_UNWRAP_SELECTORS",
  "STRIP_KEEP_ATTRIBUTES",
  "SIBLING_ARTIFACT_FILENAMES",
  "OPENAI_FEED_PATHS",
  "STATIC_ASSET_SUFFIXES",
];

/**
 * Extract the initialiser text of a top-level `const NAME = …;` declaration.
 *
 * Scans to the terminating semicolon at bracket depth zero, ignoring anything
 * inside a string or a line comment, so array and object literals containing
 * semicolons or brackets are captured whole.
 *
 * @param {string} source Full module source.
 * @param {string} name Constant name to extract.
 * @returns {string} The initialiser text, with runs of whitespace collapsed.
 */
function declarationOf(source, name) {
  // `\\s*` after the `=`: a long value may wrap onto the next line, and the
  // collapse below makes the leading whitespace irrelevant either way.
  const match = new RegExp(`^(?:export )?const ${name} =\\s*`, "m").exec(source);
  assert.ok(match, `constant ${name} not found`);

  let index = match.index + match[0].length;
  let depth = 0;
  let quote = "";
  const start = index;

  while (index < source.length) {
    const char = source[index];
    const previous = source[index - 1];

    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index === -1) break;
      continue;
    } else if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;
    } else if (char === ";" && depth === 0) {
      return source.slice(start, index).replace(/\s+/g, " ").trim();
    }
    index += 1;
  }

  throw new Error(`unterminated declaration for ${name}`);
}

for (const name of SHARED_CONSTANTS) {
  test(`${name} is identical in the Cloudflare worker and the AWS copy`, () => {
    assert.equal(
      declarationOf(awsSource, name),
      declarationOf(cloudflareSource, name),
      `${name} has drifted — update aws/lambda/lib/constants.mjs to match ` +
        "workers/edge-router-worker.js (or vice versa)",
    );
  });
}

test("every shared constant is actually exported by the AWS copy", async () => {
  const module = await import("../lambda/lib/constants.mjs");
  for (const name of SHARED_CONSTANTS) {
    assert.ok(name in module, `constants.mjs does not export ${name}`);
  }
});
