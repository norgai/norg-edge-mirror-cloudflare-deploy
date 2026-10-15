/**
 * Headed Chrome (real browser, real clicks) against the e2e WordPress site started by ui.sh.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.WP_BASE ?? "http://127.0.0.1:8889",
    channel: "chrome",
    // Headed by default (house rule: real Chrome window, real clicks). HEADLESS=1 only where no display server runs.
    headless: process.env.HEADLESS === "1",
    viewport: { width: 1360, height: 900 },
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
});
