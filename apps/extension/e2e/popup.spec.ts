import type { BrowserContext, Page, Worker } from "@playwright/test";
import type { browser } from "wxt/browser";
import { resolve } from "node:path";
import { FIXTURES_DIR, annotateElement, clearSession, expect, fixture, test, token } from "./harness";

declare const chrome: typeof browser;

/** Popup states. Screenshots go to test-results for a visual check. */
const app = fixture("vue3");

async function tabIdOf(sw: Worker, page: Page): Promise<number> {
  return sw.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, page.url());
}

async function openPopup(context: BrowserContext, sw: Worker, extensionId: string, page: Page): Promise<Page> {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 720 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${await tabIdOf(sw, page)}`);
  return popup;
}

test("connected: shows the overlay without annotation mode, counts, shortcuts and versions", async ({ context, sw, extensionId }, info) => {
  await clearSession(app.url);
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings as object), token: "" } });
  });
  const page = await context.newPage();
  await page.goto(app.url);
  await page.waitForSelector("[data-testid=save]");

  const popup = await openPopup(context, sw, extensionId, page);
  await expect(popup.getByTestId("popup-status")).toHaveText("Connected");
  await expect(popup.getByTestId("popup-mode")).toHaveText("Shown; annotation mode is off");
  // The fixture's Vite runs in fixtures/vue3 of this repository: the git top level is the root.
  await expect(popup.getByTestId("popup-root-detected")).toContainText("found from the dev server process");
  await expect(popup.getByTestId("popup-root")).toHaveAttribute("placeholder", resolve(FIXTURES_DIR, ".."));
  await expect(page.getByTestId("ua-toolbar")).toBeVisible();
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "false");
  expect(await sw.evaluate(async () => ((await chrome.storage.local.get("settings")).settings as { token: string }).token)).toBe(token());

  await expect(popup.getByTestId("popup-shortcut-overlay")).toHaveText("Ctrl+Shift+F");
  await expect(popup.getByTestId("popup-shortcut-annotate")).toHaveText("Ctrl+Shift+1");
  await expect(popup.getByTestId("popup-shortcut-markers")).toHaveText("Ctrl+Shift+2");
  await expect(popup.getByTestId("popup-shortcut-resolved")).toHaveText("Ctrl+Shift+3");
  await expect(popup.locator(".versions")).toHaveText(/server v0\.1\.0 · extension v\d+\.\d+\.\d+/);

  await page.bringToFront();
  await page.getByTestId("ua-annotate").click();
  await annotateElement(page, "[data-testid=save]", "from popup test");
  await popup.bringToFront();
  await expect(popup.getByTestId("popup-counts")).toHaveText(/1 open · 1 total/);
  await expect(popup.getByTestId("popup-mode")).toHaveText(/^\s*Annotating/);
  await popup.screenshot({ path: info.outputPath("popup-connected.png"), fullPage: true });

  await popup.getByTestId("popup-root").fill("relative/path");
  await expect(popup.getByText("Use an absolute path")).toBeVisible();
  await popup.getByTestId("popup-root").fill(app.root);
  await popup.getByTestId("popup-root").press("Enter");
  await expect(popup.getByText("Saved")).toBeVisible();
  const stored = await sw.evaluate(
    async (origin) => ((await chrome.storage.local.get("settings")).settings as { origins: Record<string, { projectRoot: string }> }).origins[origin]?.projectRoot,
    new URL(app.url).origin,
  );
  expect(stored).toBe(app.root);
});

test("automatic mode: the popup setting sends new annotations to a background run", async ({ context, sw, extensionId }, info) => {
  await clearSession(app.url);
  const page = await context.newPage();
  await page.goto(app.url);
  await page.waitForSelector("[data-testid=save]");
  const popup = await openPopup(context, sw, extensionId, page);
  await expect(popup.getByTestId("popup-status")).toHaveText("Connected");
  await expect(popup.getByTestId("popup-dispatch")).toHaveCount(0);
  await popup.getByText("Automatic mode").click();
  await popup.getByTestId("popup-agent-codex").click();
  await expect(popup.getByTestId("popup-agent-codex")).toHaveAttribute("aria-checked", "true");
  await popup.getByTestId("popup-delay").fill("0");
  await popup.getByTestId("popup-delay").press("Tab");
  await popup.screenshot({ path: info.outputPath("popup-automatic.png"), fullPage: true });
  const stored = await sw.evaluate(
    async (origin) => ((await chrome.storage.local.get("settings")).settings as { origins: Record<string, unknown> }).origins[origin],
    new URL(app.url).origin,
  );
  expect(stored).toMatchObject({ autoDispatch: true, agent: "codex", dispatchDelaySeconds: 0 });

  await page.bringToFront();
  await page.getByTestId("ua-annotate").click();
  await annotateElement(page, "[data-testid=save]", "automatic mode test");
  // playwright.config.ts points the daemon's Codex binary at e2e/fake-agent.mjs.
  await page.getByTestId("ua-marker-1").click();
  await expect(page.getByTestId("ua-card-status")).toHaveText("resolved", { timeout: 15_000 });
  await expect(page.getByTestId("ua-thread")).toContainText("fake agent ran with exec --sandbox workspace-write --skip-git-repo-check");

  await popup.bringToFront();
  await popup.getByText("Automatic mode").click();
  await expect(popup.getByTestId("popup-dispatch")).toHaveCount(0);
});

test("server not running: says so, offers the command and leaves the page alone", async ({ context, sw, extensionId }, info) => {
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings as object), serverUrl: "http://127.0.0.1:4999" } });
  });
  const page = await context.newPage();
  await page.goto(app.url);
  const popup = await openPopup(context, sw, extensionId, page);
  await expect(popup.getByTestId("popup-status")).toHaveText("Server is not running");
  await expect(popup.getByTestId("popup-offline")).toContainText("npx ui-annotate serve");
  await expect(popup.getByTestId("popup-mode")).toHaveText("Not on this page yet");
  await expect(page.locator("ui-annotate-overlay")).toHaveCount(0);
  await popup.screenshot({ path: info.outputPath("popup-offline.png"), fullPage: true });
});
