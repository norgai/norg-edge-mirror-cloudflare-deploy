/**
 * Build the deployable CloudFront Function from edge-gate.core.js: prepend the
 * runtime import, minify, and refuse anything over the size gate (AWS's limit
 * is 10 KB; the gate is deliberately lower so a growing list fails here, not
 * at deploy time).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "edge-gate.js");
const SIZE_GATE = 6 * 1024;
// es2015, not es2020: the CloudFront JS 2.0 runtime rejects newer syntax the
// minifier would otherwise emit — an optional catch binding (`catch {`) fails
// at run time with 'SyntaxError: Token "{" not supported in this version'
// (seen on the real runtime via test-function, 20 Oct 2026).
execFileSync("npx", ["--yes", "esbuild@0.24.0", join(here, "edge-gate.core.js"), "--minify", "--target=es2015", `--outfile=${out}`], { stdio: "inherit" });
const body = readFileSync(out, "utf8");
if (/catch\s*\{/.test(body)) throw new Error("edge-gate.js contains an optional catch binding, which CloudFront Functions cannot parse");
writeFileSync(out, "import cf from 'cloudfront';\n" + body);
const size = statSync(out).size;
if (size > SIZE_GATE) throw new Error(`edge-gate.js is ${size} bytes, over the ${SIZE_GATE}-byte gate`);
console.log(`edge-gate.js ${size} bytes (gate ${SIZE_GATE}, AWS limit 10240)`);
