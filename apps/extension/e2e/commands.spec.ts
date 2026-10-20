import type { Page, Worker } from "@playwright/test";
import type { browser } from "wxt/browser";
import type { OverlayAction } from "../lib/messages";
import { annotateElement, clearSession, expect, fixture, server, test, annotationsFor } from "./harness";

declare const chrome: typeof browser;

/**
 * The four extension commands. Playwright cannot press browser-level shortcuts, so the tests call
 * the same runCommand the background runs from commands.onCommand.
 */
const app = fixture("vue3");

async function run(sw: Worker, page: Page, action: OverlayAction): Promise<void> {
  await sw.evaluate(
    async ({ url, action }) => {
      const tabId = (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!;
      const api = Reflect.get(globalThis, "__uiAnnotate") as { runCommand(action: string, tabId: number): Promise<void> };
      await api.runCommand(action, tabId);
    },
    { url: page.url(), action },
  );
}

async function fresh(context: import("@playwright/test").BrowserContext): Promise<Page> {
  await clearSession(app.url);
  const page = await context.newPage();
  await page.goto(app.url);
  await page.waitForSelector("[data-testid=save]");
  return page;
}

test("overlay: first press shows it without annotation mode, then hides and shows everything", async ({ context, sw }) => {
  const page = await fresh(context);
  await run(sw, page, "overlay");
  await expect(page.getByTestId("ua-toolbar")).toBeVisible();
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "false");

  await run(sw, page, "annotate");
  await annotateElement(page, "[data-testid=save]", "marker");
  await expect(page.getByTestId("ua-marker-1")).toBeVisible();

  await run(sw, page, "overlay");
  await expect(page.getByTestId("ua-root")).toHaveCount(0);
  // Hidden means the page is untouched: its own clicks work again.
  await page.evaluate(() => document.querySelector("[data-testid=save]")!.addEventListener("click", () => Reflect.set(window, "__clicked", true)));
  await page.locator("[data-testid=save]").click();
  expect(await page.evaluate(() => Reflect.get(window, "__clicked"))).toBe(true);

  await run(sw, page, "overlay");
  await expect(page.getByTestId("ua-toolbar")).toBeVisible();
  await expect(page.getByTestId("ua-marker-1")).toBeVisible();
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "false");
});

test("annotate: first press injects and starts annotating, the next toggles", async ({ context, sw }) => {
  const page = await fresh(context);
  await run(sw, page, "annotate");
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "true");
  await run(sw, page, "annotate");
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "false");
  await run(sw, page, "annotate");
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "true");
});

test("markers and resolved toggle their part only", async ({ context, sw }) => {
  const page = await fresh(context);
  await run(sw, page, "annotate");
  await annotateElement(page, "[data-testid=save]", "one");
  await annotateElement(page, "[data-testid=card-text]", "two");
  const [first] = await annotationsFor(app.url);
  await server("POST", `/annotations/${first!.id}/actions`, { action: "resolve", summary: "done" });
  await expect(page.getByTestId("ua-marker-1")).toHaveAttribute("data-status", "resolved");

  await run(sw, page, "markers");
  await expect(page.getByTestId("ua-marker-2")).toHaveCount(0);
  await expect(page.getByTestId("ua-hide-markers")).toHaveAttribute("aria-pressed", "true");
  await run(sw, page, "markers");
  await expect(page.getByTestId("ua-marker-2")).toBeVisible();

  await run(sw, page, "resolved");
  await expect(page.getByTestId("ua-marker-1")).toHaveCount(0);
  await expect(page.getByTestId("ua-marker-2")).toBeVisible();
  await run(sw, page, "resolved");
  await expect(page.getByTestId("ua-marker-1")).toBeVisible();
});

test("a command on a hidden overlay shows it again", async ({ context, sw }) => {
  const page = await fresh(context);
  await run(sw, page, "overlay");
  await run(sw, page, "overlay");
  await expect(page.getByTestId("ua-root")).toHaveCount(0);
  await run(sw, page, "annotate");
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "true");
});
