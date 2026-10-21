/**
 * Build the deployable CloudFront Function from edge-gate.core.js.
 *
 * Usage: node aws/function/build.mjs   (also run by aws/build.mjs)
 *
 * Prepends the runtime import, minifies, and refuses anything over the size
 * gate (AWS's limit is 10 KB; the gate is deliberately lower so a growing list
 * fails here, not at deploy time). The output is aws/src/edge-gate.js: a
 * COMMITTED artifact, digested in aws/src/DIGESTS.json and inlined by
 * aws/build.mjs into aws/cloudformation/attach-gate.yaml, with the
 * __PLACEHOLDERS__ left intact for the installer to substitute.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The gate's own version line, sent as x-norg-gate-version on every hand-off. */
export const GATE_VERSION = "0.1.0";

/** Where the built artifact lives, relative to the repository. */
export const GATE_ARTIFACT = "aws/src/edge-gate.js";

/** Bytes the built function may not exceed. AWS allows 10,240. */
export const GATE_SIZE_LIMIT = 6 * 1024;

/**
 * The placeholders the installer fills, in the order they appear in the source.
 *
 * Every one of these is substituted either by the attach-gate.yaml template
 * (Fn::Sub, one parameter each) or by whoever deploys the function by hand.
 */
export const GATE_PLACEHOLDERS = [
  "__SITE_ID__",
  "__RECEPTIONIST_HOST__",
  "__RECEPTIONIST_ORIGIN_ID__",
  "__CUSTOMER_ORIGIN_ID__",
  "__GATE_VERSION__",
];

/**
 * Build aws/src/edge-gate.js from edge-gate.core.js.
 *
 * @returns {{path: string, size: number, body: string}} The written artifact.
 */
export function buildGate() {
  const out = join(here, "..", "src", "edge-gate.js");
  // es2015, not es2020: the CloudFront JS 2.0 runtime rejects newer syntax the
  // minifier would otherwise emit — an optional catch binding (`catch {`) fails
  // at run time with 'SyntaxError: Token "{" not supported in this version'
  // (seen on the real runtime via test-function, 20 Oct 2026).
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(here, "edge-gate.core.js"), "--minify", "--target=es2015", `--outfile=${out}`],
    { stdio: "inherit" },
  );
  const minified = readFileSync(out, "utf8");
  if (/catch\s*\{/.test(minified)) {
    throw new Error("edge-gate.js contains an optional catch binding, which CloudFront Functions cannot parse");
  }
  // The template inlines this code through Fn::Sub, where "${" opens a
  // substitution. The source builds strings by concatenation so none should
  // appear; if the minifier ever emits a template literal, fail here rather
  // than at the customer's first stack create.
  if (minified.includes("${")) {
    throw new Error("edge-gate.js contains \"${\", which Fn::Sub in attach-gate.yaml would try to substitute");
  }
  for (const placeholder of GATE_PLACEHOLDERS) {
    if (!minified.includes(placeholder)) {
      throw new Error(`edge-gate.js lost placeholder ${placeholder}; the installer could not fill it`);
    }
  }
  const body = `import cf from 'cloudfront';\n${minified}`;
  writeFileSync(out, body);
  const size = statSync(out).size;
  if (size > GATE_SIZE_LIMIT) throw new Error(`edge-gate.js is ${size} bytes, over the ${GATE_SIZE_LIMIT}-byte gate`);
  return { path: out, size, body };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { size } = buildGate();
  console.log(`edge-gate.js ${size} bytes (gate ${GATE_SIZE_LIMIT}, AWS limit 10240, version ${GATE_VERSION})`);
}
