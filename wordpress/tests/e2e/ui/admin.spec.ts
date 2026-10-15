/**
 * The customer's journey through the plugin's admin screens, in a real Chrome window.
 *
 * Credentials are NOT in wp-config.php for this run (ui.sh), so the test pastes
 * them into the settings form exactly as a customer would, then proves the
 * status panel, self-check, kill switch, Site Health tests and debug report.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE_ID = process.env.MOCK_SITE_ID ?? "9f1c2e4a-1111-4222-8333-444455556666";
const SITE_KEY = process.env.MOCK_SITE_KEY ?? "nek_live_e2eTestKeyAAAAAAAAAAAAAAAAAAAAAA";
const SHOTS = process.env.SCREENSHOT_DIR ?? join(__dirname, "../../../screenshots");
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";

async function login(page: Page) {
  await page.goto("/wp-login.php");
  await page.getByLabel("Username or Email Address").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("admin");
  await page.getByRole("button", { name: "Log In" }).click();
  await page.waitForLoadState("load");
  await page.goto("/wp-admin/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

function statusRow(page: Page, label: string) {
  return page.locator("tr", { has: page.locator("th", { hasText: label }) });
}

test.describe.serial("NORG Edge Router admin", () => {
  test("a not-yet-connected site says so and links to the settings", async ({ page }) => {
    await login(page);
    const notice = page.locator(".notice", { hasText: "installed but not connected yet" });
    await expect(notice).toBeVisible();
    await notice.getByRole("link", { name: "Open NORG Edge Router" }).click();
    await expect(page.getByRole("heading", { name: "NORG Edge Router", level: 1 })).toBeVisible();
    await expect(statusRow(page, "Connection")).toContainText("Not connected");
    await page.screenshot({ path: join(SHOTS, "wp-admin-01-not-connected.png"), fullPage: true });
  });

  test("a malformed key is refused with a clear message", async ({ page }) => {
    await login(page);
    await page.goto("/wp-admin/options-general.php?page=norg-edge-router");
    await page.getByLabel("Site ID").fill(SITE_ID);
    await page.getByLabel("Site Key").fill("not-a-key");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("does not look like a NORG site key")).toBeVisible();
  });

  test("pasting the Site ID and Key connects, and Run checks proves agents reach the plugin", async ({ page }) => {
    await login(page);
    await page.goto("/wp-admin/options-general.php?page=norg-edge-router");
    await page.getByLabel("Site ID").fill(SITE_ID);
    await page.getByLabel("Site Key").fill(SITE_KEY);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    await expect(page.getByLabel("Site Key")).toHaveAttribute("placeholder", /^nek_live_…/);

    await page.getByRole("link", { name: "Run checks" }).click();
    await expect(statusRow(page, "Connection")).toContainText("Connected and entitled");
    await expect(statusRow(page, "AI agents reach plugin")).toContainText("Yes");
    await expect(statusRow(page, "People untouched")).toContainText("Yes");
    await expect(statusRow(page, "Search engines untouched")).toContainText("Yes");
    await expect(statusRow(page, "Simulated AI agent")).toContainText("mirror");
    await expect(statusRow(page, "Last heartbeat")).toContainText("ago");
    await expect(statusRow(page, "Last heartbeat")).not.toContainText("HTTP");
    await page.screenshot({ path: join(SHOTS, "wp-admin-02-connected-checks.png"), fullPage: true });
  });

  test("the Disable switch takes effect on the next request", async ({ page, request }) => {
    await login(page);
    await page.goto("/wp-admin/options-general.php?page=norg-edge-router");
    const before = await request.get("/", { headers: { "user-agent": GPTBOT } });
    expect(before.headers()["x-norg-edge"]).toBe("mirror");

    await page.getByLabel("Disable (every visitor gets your normal site)").check();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(statusRow(page, "Connection")).toContainText("Disabled");
    const off = await request.get("/", { headers: { "user-agent": GPTBOT } });
    expect(off.headers()["x-norg-edge"]).toBeUndefined();
    await page.screenshot({ path: join(SHOTS, "wp-admin-03-disabled.png"), fullPage: true });

    await page.getByLabel("Disable (every visitor gets your normal site)").uncheck();
    await page.getByRole("button", { name: "Save Changes" }).click();
    const on = await request.get("/", { headers: { "user-agent": GPTBOT } });
    expect(on.headers()["x-norg-edge"]).toBe("mirror");
  });

  test("Site Health shows the plugin's tests as passed", async ({ page }) => {
    await login(page);
    await page.goto("/wp-admin/site-health.php");
    await page.getByRole("button", { name: /Passed tests/ }).click();
    await expect(page.getByText("NORG Edge Router is connected")).toBeVisible();
    await expect(page.getByText("AI agents reach the plugin")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "wp-admin-04-site-health.png"), fullPage: true });
  });

  test("the debug report downloads and never contains the site key", async ({ page }) => {
    await login(page);
    await page.goto("/wp-admin/options-general.php?page=norg-edge-router");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download debug report" }).click();
    const file = await (await download).path();
    const text = readFileSync(file, "utf8");
    const report = JSON.parse(text);
    expect(report.status.platform).toBe("wordpress");
    expect(text).not.toContain(SITE_KEY);
    expect(report.site_key).toMatch(/^nek_live_…/);
  });
});
