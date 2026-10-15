/**
 * The published package: build output, exports map and version agreement.
 *
 * @description Builds dist/ and proves what npm would ship actually works.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EDGE_SCRIPT_VERSION } from "../src/lib/config.js";
import { CHROME_UA, OPTIONS, html, stubNetwork, vercelRequest } from "./helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const realFetch = globalThis.fetch;

before(() => {
  execFileSync("node", [join(root, "build.mjs")], { stdio: "pipe" });
});

after(() => {
  globalThis.fetch = realFetch;
});

test("package.json version and the reported router version agree", () => {
  assert.equal(pkg.version, EDGE_SCRIPT_VERSION);
});

test("every exports-map target exists after the build", () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const files = typeof target === "string" ? [target] : Object.values(target);
    for (const file of files) assert.ok(existsSync(join(root, file)), `${subpath} -> ${file}`);
  }
});

test("the built bundle serves an agent and leaves a person alone", async () => {
  const dist = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  assert.equal(dist.version, EDGE_SCRIPT_VERSION);
  stubNetwork({ mirror: () => html("<html>m</html>") });
  const handler = dist.createNorgEdge(OPTIONS);
  assert.equal(await handler(vercelRequest({ userAgent: CHROME_UA })), undefined);
  const agent = await handler(vercelRequest());
  assert.equal(agent.headers.get("x-norg-edge"), "mirror");
});

test("both entry points share one module instance (one feed per app)", () => {
  const next = readFileSync(join(root, "dist", "next.js"), "utf8");
  const index = readFileSync(join(root, "dist", "index.js"), "utf8");
  const chunk = (code) => code.match(/from "(\.\/chunks\/[^"]+)"/)[1];
  assert.equal(chunk(next), chunk(index));
});
