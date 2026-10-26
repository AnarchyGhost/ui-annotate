import type { BrowserContext, Page, Worker } from "@playwright/test";
import type { browser } from "wxt/browser";
import { resolve } from "node:path";
import { FIXTURES_DIR, SERVER_URL, annotateElement, annotationsFor, clearSession, expect, fixture, test, token } from "./harness";

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

test("Background agent: the popup setting sends new annotations to a background run", async ({ context, sw, extensionId }, info) => {
  await clearSession(app.url);
  const page = await context.newPage();
  await page.goto(app.url);
  await page.waitForSelector("[data-testid=save]");
  const popup = await openPopup(context, sw, extensionId, page);
  await expect(popup.getByTestId("popup-status")).toHaveText("Connected");
  await expect(popup.getByTestId("popup-dispatch")).toHaveCount(0);
  await popup.getByTestId("popup-mode-background").click();
  await expect(popup.getByTestId("popup-mode-background")).toHaveAttribute("aria-checked", "true");
  await popup.getByTestId("popup-agent-codex").click();
  await expect(popup.getByTestId("popup-agent-codex")).toHaveAttribute("aria-checked", "true");
  await popup.getByTestId("popup-delay").fill("0");
  await popup.getByTestId("popup-delay").press("Tab");
  await popup.screenshot({ path: info.outputPath("popup-automatic.png"), fullPage: true });
  const stored = await sw.evaluate(
    async (origin) => ((await chrome.storage.local.get("settings")).settings as { origins: Record<string, unknown> }).origins[origin],
    new URL(app.url).origin,
  );
  expect(stored).toMatchObject({ mode: "background", agent: "codex", dispatchDelaySeconds: 0 });

  await page.bringToFront();
  await page.getByTestId("ua-annotate").click();
  await annotateElement(page, "[data-testid=save]", "background agent test");
  // playwright.config.ts points the daemon's Codex binary at e2e/fake-agent.mjs.
  await page.getByTestId("ua-marker-1").click();
  await expect(page.getByTestId("ua-card-status")).toHaveText("resolved", { timeout: 15_000 });
  await expect(page.getByTestId("ua-thread")).toContainText("fake agent ran with exec --sandbox workspace-write --skip-git-repo-check");

  await popup.bringToFront();
  await popup.getByTestId("popup-mode-off").click();
  await expect(popup.getByTestId("popup-dispatch")).toHaveCount(0);
});

test("Background agent: a site saved with the old automatic mode switch keeps it", async ({ context, sw, extensionId }) => {
  await sw.evaluate(async (origin) => {
    const { settings } = (await chrome.storage.local.get("settings")) as { settings: { origins?: Record<string, object> } };
    await chrome.storage.local.set({ settings: { ...settings, origins: { ...settings.origins, [origin]: { autoDispatch: true, agent: "cursor" } } } });
  }, new URL(app.url).origin);
  const page = await context.newPage();
  await page.goto(app.url);
  const popup = await openPopup(context, sw, extensionId, page);
  await expect(popup.getByTestId("popup-mode-background")).toHaveAttribute("aria-checked", "true");
  await expect(popup.getByTestId("popup-agent-cursor")).toHaveAttribute("aria-checked", "true");
});

test("Live session: the popup lists channel sessions and sends new annotations to the chosen one", async ({ context, sw, extensionId }, info) => {
  await clearSession(app.url);
  await sw.evaluate(
    async ({ origin, root }) => {
      const { settings } = (await chrome.storage.local.get("settings")) as { settings: { origins?: Record<string, object> } };
      await chrome.storage.local.set({ settings: { ...settings, origins: { ...settings.origins, [origin]: { projectRoot: root } } } });
    },
    { origin: new URL(app.url).origin, root: app.root },
  );
  // Two stand-ins for Claude Code sessions: the stdio MCP server registers exactly like this.
  const streams = [7101, 7102].map((pid) => {
    const controller = new AbortController();
    const query = new URLSearchParams({ clientPid: String(pid), cwd: app.root, entrypoint: "cli" });
    void fetch(`${SERVER_URL}/events?${query}`, { headers: { authorization: `Bearer ${token()}` }, signal: controller.signal })
      .then((response) => response.body?.pipeTo(new WritableStream()))
      .catch(() => undefined);
    return controller;
  });
  try {
    const page = await context.newPage();
    await page.goto(app.url);
    await page.waitForSelector("[data-testid=save]");
    const popup = await openPopup(context, sw, extensionId, page);
    await expect(popup.getByTestId("popup-status")).toHaveText("Connected");
    await popup.getByTestId("popup-mode-session").click();
    await expect(popup.getByTestId("popup-client-7101")).toBeVisible();
    await expect(popup.getByTestId("popup-client-7102")).toBeVisible();
    await popup.getByTestId("popup-client-7102").click();
    await expect(popup.getByTestId("popup-client-7102")).toHaveAttribute("aria-checked", "true");
    await popup.screenshot({ path: info.outputPath("popup-live-session.png"), fullPage: true });
    const stored = await sw.evaluate(
      async (origin) => ((await chrome.storage.local.get("settings")).settings as { origins: Record<string, unknown> }).origins[origin],
      new URL(app.url).origin,
    );
    expect(stored).toMatchObject({ mode: "session", clientPid: 7102 });

    await page.bringToFront();
    await page.getByTestId("ua-annotate").click();
    await annotateElement(page, "[data-testid=save]", "live session test");
    await expect.poll(async () => (await annotationsFor(app.url)).map((annotation) => annotation.delivery)).toEqual([{ mode: "session", clientPid: 7102 }]);

    // The chosen session quits: the site and its waiting annotation move to the only one left.
    streams[1]!.abort();
    await popup.bringToFront();
    await expect(popup.getByTestId("popup-client-7101")).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await annotationsFor(app.url)).map((annotation) => annotation.delivery)).toEqual([{ mode: "session", clientPid: 7101 }]);
    // No session left: the popup says the chosen one is not running.
    streams[0]!.abort();
    await expect(popup.getByTestId("popup-client-offline")).toContainText("PID 7101");
  } finally {
    for (const stream of streams) stream.abort();
  }
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
