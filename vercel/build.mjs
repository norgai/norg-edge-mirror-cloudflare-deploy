/**
 * Bundle vercel/src/ into the publishable package at vercel/dist/.
 *
 * Usage: node vercel/build.mjs   (or: npm run build, inside vercel/)
 *
 * The package imports the provider-neutral core (../core, ../workers/lib) by
 * relative path, which does not exist once installed from npm, so everything
 * is inlined. Two entry points (the framework-neutral one and the Next.js
 * one) share a chunk rather than each carrying a copy: the feed cache is
 * module state, and an app importing both must hold ONE feed, not two.
 *
 * dist/ is NOT committed. npm is the distribution and its tarball carries the
 * integrity; `prepack` runs this build, and CI builds and packs on every PR.
 *
 * esbuild is invoked through npx with a PINNED version, the same arrangement
 * as the other adapters, so the build is zero-install and deterministic.
 */

import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ESBUILD_VERSION = "0.25.5";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, "dist");

// Names that must NEVER appear in code that ships into a customer's project.
// Mirrors the deploy-time guard in content-craft's worker_source.py.
const FORBIDDEN_NAMES = [
  "CRAWLER_EVENT_SECRET",
  "WORKER_AUTH_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "INTERNAL_API_KEY",
  "EDGE_BUCKET",
];

rmSync(outdir, { recursive: true, force: true });
execFileSync(
  "npx",
  [
    "--yes",
    `esbuild@${ESBUILD_VERSION}`,
    join(here, "src", "index.js"),
    join(here, "src", "next.js"),
    "--bundle",
    "--splitting",
    "--format=esm",
    "--platform=neutral",
    "--target=es2022",
    "--chunk-names=chunks/[name]-[hash]",
    "--legal-comments=none",
    `--outdir=${outdir}`,
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);
cpSync(join(here, "types"), outdir, { recursive: true });

// Guards: the bundle must be self-contained and must carry no NORG secret.
for (const file of listJs(outdir)) {
  const code = readFileSync(file, "utf8");
  const imports = [...code.matchAll(/\bfrom\s*"([^"]+)"/g)].map((m) => m[1]);
  const foreign = imports.filter((spec) => !spec.startsWith("./") && !spec.startsWith("../"));
  if (foreign.length) throw new Error(`${file}: unbundled imports ${foreign.join(", ")}`);
  const leaked = FORBIDDEN_NAMES.filter((name) => code.includes(name));
  if (leaked.length) throw new Error(`${file}: forbidden names ${leaked.join(", ")}`);
}
console.log(`built ${outdir}`);

/**
 * Every .js file under a directory.
 *
 * @param {string} dir Directory.
 * @returns {string[]} Absolute paths.
 */
function listJs(dir) {
  // Walked by hand: readdirSync's `recursive` option needs Node 20.1.
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJs(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}
