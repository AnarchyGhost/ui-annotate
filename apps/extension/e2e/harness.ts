import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import type { Annotation } from "@ui-annotate/protocol";
import type { browser } from "wxt/browser";
import { E2E_DIR, E2E_PORT } from "../playwright.config";

/** Callbacks of `sw.evaluate` run inside the extension service worker, where `chrome` exists. */
declare const chrome: typeof browser;

export const EXTENSION_PATH = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));
export const SERVER_URL = `http://127.0.0.1:${E2E_PORT}`;
export const FIXTURES_DIR = resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));

export interface ExpectedTarget {
  selector: string;
  framework: string | null;
  componentName: string | null;
  file: string;
  line: number | null;
}

export interface FixtureExpectation {
  url: string;
  port: number;
  targets: ExpectedTarget[];
}

export function fixture(name: string): FixtureExpectation & { root: string } {
  const root = join(FIXTURES_DIR, name);
  return { ...(JSON.parse(readFileSync(join(root, "expected.json"), "utf8")) as FixtureExpectation), root };
}

export const token = () => readFileSync(join(E2E_DIR, "token"), "utf8").trim();

export async function server<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function annotationsFor(pageUrl: string): Promise<Annotation[]> {
  const session = await server<{ id: string }>("GET", `/sessions?url=${encodeURIComponent(pageUrl)}`);
  return server<Annotation[]>("GET", `/sessions/${session.id}/annotations`);
}

export async function clearSession(pageUrl: string): Promise<void> {
  const response = await fetch(`${SERVER_URL}/sessions?url=${encodeURIComponent(pageUrl)}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!response.ok) return;
  const session = (await response.json()) as { id: string };
  for (const annotation of await server<Annotation[]>("GET", `/sessions/${session.id}/annotations`)) {
    await server("DELETE", `/annotations/${annotation.id}`);
  }
}

interface Fixtures {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
}

/** Chrome for Testing with the unpacked build; `options` set viewport, scale and color scheme. */
export function launchWithExtension(options: Parameters<typeof chromium.launchPersistentContext>[1] = {}): Promise<BrowserContext> {
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    ...options,
  });
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await launchWithExtension();
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    await worker.evaluate(
      async ({ serverUrl, token }) => {
        await chrome.storage.local.set({ settings: { serverUrl, token, origins: {} } });
      },
      { serverUrl: SERVER_URL, token: token() },
    );
    await use(worker);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;

async function tabIdOf(sw: Worker, page: Page): Promise<number> {
  const url = page.url();
  const id = await sw.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)?.id ?? null;
  }, url);
  if (id === null) throw new Error(`no tab for ${url}`);
  return id;
}

/** Injection path of an icon click: resolver in MAIN, overlay in ISOLATED, then annotate mode. */
export async function injectAndActivate(sw: Worker, page: Page): Promise<void> {
  const tabId = await tabIdOf(sw, page);
  await sw.evaluate(async (id) => {
    const api = Reflect.get(globalThis, "__uiAnnotate") as { injectInto(tabId: number): Promise<void> };
    await api.injectInto(id);
    await chrome.tabs.sendMessage(id, { type: "overlay.activate" });
  }, tabId);
  await expect(page.getByTestId("ua-toolbar")).toBeVisible();
  await expect(page.getByTestId("ua-annotate")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ua-status")).toHaveAttribute("data-state", "online");
}

/** Always-on path: registration at document_start for the origin, then reload. */
export async function enableAlwaysOn(sw: Worker, origin: string, projectRoot: string): Promise<void> {
  await sw.evaluate(
    async ({ origin, projectRoot }) => {
      const stored = (await chrome.storage.local.get("settings")).settings as { origins: Record<string, unknown> };
      stored.origins[origin] = { alwaysOn: true, projectRoot, includeHash: false, hideResolved: false };
      await chrome.storage.local.set({ settings: stored });
      const api = Reflect.get(globalThis, "__uiAnnotate") as { syncRegistrations(): Promise<void> };
      await api.syncRegistrations();
    },
    { origin, projectRoot },
  );
}

/** Clicks an element in annotate mode, types the comment and saves; returns the created annotation. */
export async function annotateElement(page: Page, selector: string, comment: string): Promise<void> {
  await page.locator(selector).first().click();
  const editor = page.getByTestId("ua-editor");
  await expect(editor).toBeVisible();
  await page.getByTestId("ua-comment").fill(comment);
  await page.getByTestId("ua-comment").press("Enter");
  await expect(editor).toBeHidden();
}
