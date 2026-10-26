import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test as base, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { formatAnnotationMarkdown, type Annotation } from "@ui-annotate/protocol";
import { HttpApi, presentAnnotations } from "ui-annotate";
import type { browser } from "wxt/browser";
import { SERVER_URL, annotationsFor, clearSession, enableAlwaysOn, launchWithExtension, server, token } from "../e2e/harness";

declare const chrome: typeof browser;

const DEMO_URL = "http://127.0.0.1:5180/";
const DEMO_ROOT = fileURLToPath(new URL("../../../examples/demo", import.meta.url));
const IMAGES = fileURLToPath(new URL("../../../docs/images/", import.meta.url));

const test = base.extend<{ context: BrowserContext; sw: Worker }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await launchWithExtension({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "light" });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    await worker.evaluate(
      async ({ serverUrl, token }) => chrome.storage.local.set({ settings: { serverUrl, token, origins: {} } }),
      { serverUrl: SERVER_URL, token: token() },
    );
    await use(worker);
  },
});
const { expect } = test;

async function annotate(page: Page, selector: string, comment: string): Promise<void> {
  await page.locator(selector).first().click();
  await expect(page.getByTestId("ua-editor")).toBeVisible();
  await page.getByTestId("ua-comment").fill(comment);
  await page.getByTestId("ua-comment").press("Enter");
  await expect(page.getByTestId("ua-editor")).toBeHidden();
}

const agent = (id: string, body: Record<string, string>) => server("POST", `/annotations/${id}/actions`, body);

test("README screenshots", async ({ context, sw }) => {
  mkdirSync(IMAGES, { recursive: true });
  await clearSession(DEMO_URL);
  await enableAlwaysOn(sw, new URL(DEMO_URL).origin, DEMO_ROOT);
  const page = await context.newPage();
  await page.goto(DEMO_URL);
  await expect(page.getByTestId("ua-toolbar")).toBeVisible();
  await page.getByTestId("ua-annotate").click();

  // 1. The editor over a picked element: selector, component and file:line of the target.
  await page.locator("[data-testid=upgrade]").click();
  await expect(page.getByTestId("ua-editor")).toBeVisible();
  await page.getByTestId("ua-comment").fill("Upgrade is the main action here: make it primary, like Invite");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${IMAGES}editor.png` });
  await page.getByTestId("ua-comment").press("Enter");
  await expect(page.getByTestId("ua-editor")).toBeHidden();

  await annotate(page, ".team h2", "Rename the section to Team members");
  // Area: drag across the chart.
  const bars = (await page.getByTestId("usage-bars").boundingBox())!;
  await page.mouse.move(bars.x + 4, bars.y + 4);
  await page.mouse.down();
  await page.mouse.move(bars.x + bars.width - 4, bars.y + bars.height - 4, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("ua-editor")).toBeVisible();
  await page.getByTestId("ua-comment").fill("Show the value of each day on hover");
  await page.getByTestId("ua-comment").press("Enter");
  await expect(page.getByTestId("ua-editor")).toBeHidden();

  // 2. What the agent receives from get_pending (paths relative to the project root).
  const annotations = await annotationsFor(DEMO_URL);
  expect(annotations).toHaveLength(3);
  const api = new HttpApi(SERVER_URL, token());
  const presented = await presentAnnotations(api, annotations, null);
  // Source of the get_pending sample in the READMEs.
  writeFileSync(test.info().outputPath("get_pending.md"),presented.map((annotation: Annotation) => formatAnnotationMarkdown(annotation)).join("\n\n---\n\n"));

  // 3. The agent works through them: resolve, a question, one left pending.
  const [upgrade, seats] = annotations;
  await agent(upgrade!.id, { action: "acknowledge" });
  await agent(upgrade!.id, {
    action: "resolve",
    summary: "PlanCard.vue: Upgrade plan now uses btn-primary, the same style as Invite. Cancel subscription stays a red link.",
  });
  await agent(seats!.id, { action: "acknowledge" });
  await agent(seats!.id, { action: "reply", message: "Should the column header Seat change too, or only the section title?" });

  await page.getByTestId("ua-annotate").click();
  await page.getByTestId("ua-marker-1").click();
  await expect(page.getByTestId("ua-card-status")).toHaveText("resolved");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${IMAGES}overlay.png` });
  await page.keyboard.press("Escape");
  await page.getByTestId("ua-marker-2").click();
  await expect(page.getByTestId("ua-thread")).toContainText("Should the column header");
  await page.screenshot({ path: `${IMAGES}thread.png` });
  await page.keyboard.press("Escape");

  // 4. Popup with Background agent mode on.
  await sw.evaluate(async (origin) => {
    const { settings } = (await chrome.storage.local.get("settings")) as { settings: { origins: Record<string, object> } };
    settings.origins[origin] = { ...settings.origins[origin], mode: "background", agent: "claude", dispatchDelaySeconds: 5 };
    await chrome.storage.local.set({ settings });
  }, new URL(DEMO_URL).origin);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!, DEMO_URL);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html?tabId=${tabId}`);
  await expect(popup.getByTestId("popup-status")).toHaveText("Connected");
  await expect(popup.getByTestId("popup-dispatch")).toBeVisible();
  // Display only: the machine's home path stays out of the published image.
  await popup.getByTestId("popup-root").evaluate((input: HTMLInputElement) => (input.value = "~/projects/northwind"));
  await popup.screenshot({ path: `${IMAGES}popup.png`, fullPage: true });

  await clearSession(DEMO_URL);
});
