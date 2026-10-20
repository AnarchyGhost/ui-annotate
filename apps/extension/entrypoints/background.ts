import type { Annotation, Session } from "@ui-annotate/protocol";
import { browser, type Browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import {
  COMMAND_ACTIONS,
  EVENTS_PORT,
  type BackgroundRequest,
  type BackgroundResponse,
  type OverlayAction,
  type OverlayMessage,
  type PortToBackground,
  type PortToOverlay,
  type ResponseMap,
  type ServerStatus,
  type Shortcuts,
} from "../lib/messages";
import { ServerClient, ServerError } from "../lib/server";
import {
  isLoopbackOrigin,
  loadSettings,
  originSettings,
  permissionPattern,
  registrationPattern,
  saveSettings,
  updateOrigin,
} from "../lib/settings";

const FIREFOX = import.meta.env.FIREFOX;
/** Daemon API level this build needs (packages/server/src/version.ts); 4 brings automatic mode. */
const SERVER_API_LEVEL = 4;

const RESOLVER_FILE = "/content-scripts/resolver.js";
const OVERLAY_FILE = "/content-scripts/overlay.js";
const REGISTRATION_PREFIX = "ui-annotate:";

/** Gets the token from the daemon (POST /pair) and stores it; nobody has to paste it. */
async function pair(serverUrl: string): Promise<string> {
  const token = await new ServerClient(serverUrl, "").pair();
  await saveSettings({ token });
  return token;
}

async function client(): Promise<ServerClient> {
  const settings = await loadSettings();
  return new ServerClient(settings.serverUrl, settings.token || (await pair(settings.serverUrl)));
}

/** A 401 means the daemon has another token (reset, new machine): pair again once and retry. */
async function withServer<T>(work: (api: ServerClient) => Promise<T>): Promise<T> {
  try {
    return await work(await client());
  } catch (error) {
    if (!(error instanceof ServerError && error.status === 401)) throw error;
    const { serverUrl } = await loadSettings();
    return work(new ServerClient(serverUrl, await pair(serverUrl)));
  }
}

/** True when an overlay content script of this extension answers in the tab. */
async function hasOverlay(tabId: number): Promise<boolean> {
  return browser.tabs.sendMessage(tabId, { type: "overlay.state" } satisfies OverlayMessage).then(
    () => true,
    () => false,
  );
}

/**
 * Injects only what is missing. Running the overlay script again would start a second WXT
 * content-script context, which invalidates the first one and removes its UI.
 */
async function injectInto(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, files: [RESOLVER_FILE], world: "MAIN" });
  if (await hasOverlay(tabId)) return;
  await browser.scripting.executeScript({ target: { tabId }, files: [OVERLAY_FILE] });
}

/**
 * A shortcut on a page without the overlay injects it first. There "overlay" means show it and
 * "annotate" means start annotating; any other action is applied after showing.
 * The overlay does not listen to these keys itself: Firefox would deliver each press twice.
 */
async function runCommand(action: OverlayAction, tabId: number): Promise<void> {
  if (await hasOverlay(tabId)) {
    await sendToOverlay(tabId, { type: "overlay.command", action });
    return;
  }
  await injectInto(tabId);
  if (action === "overlay") return sendToOverlay(tabId, { type: "overlay.show" });
  if (action === "annotate") return sendToOverlay(tabId, { type: "overlay.activate" });
  await sendToOverlay(tabId, { type: "overlay.show" });
  await sendToOverlay(tabId, { type: "overlay.command", action });
}

async function shortcuts(): Promise<Shortcuts> {
  const result: Shortcuts = { overlay: null, annotate: null, markers: null, resolved: null };
  for (const command of await browser.commands.getAll()) {
    const action = command.name ? COMMAND_ACTIONS[command.name] : undefined;
    if (action) result[action] = command.shortcut || null;
  }
  return result;
}

async function sendToOverlay(tabId: number, message: OverlayMessage): Promise<void> {
  await browser.tabs.sendMessage(tabId, message);
}

let syncChain: Promise<void> = Promise.resolve();

/**
 * Keeps `scripting` registrations equal to the always-on origins in settings. Registrations
 * persist across browser restarts, so stale ones from removed origins are dropped here.
 * Calls are serialized: concurrent runs would both register the same id and one would fail.
 */
function syncRegistrations(): Promise<void> {
  const run = syncChain.then(syncRegistrationsNow);
  syncChain = run.catch(() => undefined);
  return run;
}

async function syncRegistrationsNow(): Promise<void> {
  const settings = await loadSettings();
  const wanted = Object.entries(settings.origins)
    .filter(([, value]) => value.alwaysOn)
    .map(([origin]) => origin);
  const registered = await browser.scripting.getRegisteredContentScripts();
  const ours = registered.filter((script) => script.id.startsWith(REGISTRATION_PREFIX));
  const stale = ours.filter((script) => !wanted.some((origin) => script.id.endsWith(`|${origin}`)));
  if (stale.length > 0) await browser.scripting.unregisterContentScripts({ ids: stale.map((script) => script.id) });

  const existing = new Set(ours.map((script) => script.id));
  const scripts: Browser.scripting.RegisteredContentScript[] = [];
  for (const origin of wanted) {
    const matches = [registrationPattern(origin, FIREFOX)];
    const resolverId = `${REGISTRATION_PREFIX}resolver|${origin}`;
    const overlayId = `${REGISTRATION_PREFIX}overlay|${origin}`;
    if (!existing.has(resolverId)) {
      scripts.push({ id: resolverId, js: [RESOLVER_FILE], matches, runAt: "document_start", world: "MAIN", allFrames: false });
    }
    if (!existing.has(overlayId)) {
      scripts.push({ id: overlayId, js: [OVERLAY_FILE], matches, runAt: "document_idle", allFrames: false });
    }
  }
  if (scripts.length > 0) await browser.scripting.registerContentScripts(scripts);
}

/**
 * Read-only: opening the popup must not pair, it may point at another daemon than intended.
 * Pairing happens on the first real request (the overlay opening its session).
 */
async function status(): Promise<ServerStatus> {
  const settings = await loadSettings();
  const hostAccess = await browser.permissions.contains({ origins: [permissionPattern(settings.serverUrl)] });
  const api = new ServerClient(settings.serverUrl, settings.token);
  const health = await api.health();
  const tokenValid =
    health && settings.token
      ? await api.request("GET", "/sessions").then(
          () => true,
          () => false,
        )
      : false;
  return {
    serverUrl: settings.serverUrl,
    hostAccess,
    reachable: health !== null,
    outdated: health !== null && (health.api ?? 1) < SERVER_API_LEVEL,
    tokenSet: settings.token.length > 0,
    tokenValid,
    version: health?.version ?? null,
  };
}

async function handle(request: BackgroundRequest, senderTabId: number | undefined): Promise<ResponseMap[BackgroundRequest["type"]]> {
  switch (request.type) {
    case "resolver.ensure":
      if (senderTabId === undefined) throw new Error("resolver.ensure must come from a tab");
      await browser.scripting.executeScript({ target: { tabId: senderTabId }, files: [RESOLVER_FILE], world: "MAIN" });
      return { ok: true };
    case "session.open": {
      const origin = new URL(request.url).origin;
      const settings = originSettings(await loadSettings(), origin);
      return withServer(async (api) => {
        const session = await api.request<Session>("POST", "/sessions", {
          url: request.url,
          title: request.title,
          includeHash: settings.includeHash,
          projectRoot: settings.projectRoot,
        });
        const annotations = await api.request<Annotation[]>("GET", `/sessions/${encodeURIComponent(session.id)}/annotations`);
        return { session, annotations, origin: settings };
      });
    }
    case "annotation.create": {
      // Automatic mode comes from the site settings only, whatever the overlay sent.
      const settings = originSettings(await loadSettings(), new URL(request.input.url).origin);
      const dispatch = settings.autoDispatch ? { agent: settings.agent, delaySeconds: settings.dispatchDelaySeconds } : null;
      return withServer((api) =>
        api.request("POST", `/sessions/${encodeURIComponent(request.sessionId)}/annotations`, { ...request.input, dispatch }),
      );
    }
    case "annotation.patch":
      return withServer((api) => api.request("PATCH", `/annotations/${encodeURIComponent(request.id)}`, request.patch));
    case "annotation.delete":
      return withServer((api) => api.request("DELETE", `/annotations/${encodeURIComponent(request.id)}`));
    case "annotation.comment":
      return withServer((api) => api.request("POST", `/annotations/${encodeURIComponent(request.id)}/thread`, { body: request.body }));
    case "origin.get":
      return originSettings(await loadSettings(), request.origin);
    case "origin.set": {
      const next = await updateOrigin(request.origin, request.settings);
      if (request.settings.alwaysOn !== undefined) await syncRegistrations();
      return next;
    }
    case "status":
      return status();
    case "tab.activate":
      await injectInto(request.tabId);
      await sendToOverlay(request.tabId, { type: "overlay.activate" });
      return { ok: true };
    case "tab.show":
      await injectInto(request.tabId);
      await sendToOverlay(request.tabId, { type: "overlay.show" });
      return { ok: true };
    case "shortcuts.get":
      return shortcuts();
  }
}

function onEventsPort(port: Browser.runtime.Port): void {
  if (port.name !== EVENTS_PORT) return;
  const controller = new AbortController();
  const post = (message: PortToOverlay) => {
    try {
      port.postMessage(message);
    } catch {
      controller.abort();
    }
  };
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((raw: unknown) => {
    const message = raw as PortToBackground;
    if (message.type !== "subscribe") return;
    void (async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          const api = await client();
          await api.streamSession(
            message.sessionId,
            controller.signal,
            (event) => post({ type: "event", event }),
            () => {
              delay = 1000;
              post({ type: "stream", state: "open" });
            },
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          // Stale token: drop it, the next client() pairs again.
          if (error instanceof ServerError && error.status === 401) await saveSettings({ token: "" });
          post({ type: "stream", state: "error" });
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 15_000);
      }
    })();
  });
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const request = raw as BackgroundRequest;
    handle(request, sender.tab?.id).then(
      (data) => sendResponse({ ok: true, data } satisfies BackgroundResponse<typeof request.type>),
      (error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          status: error instanceof ServerError ? error.status : undefined,
        } satisfies BackgroundResponse<typeof request.type>),
    );
    return true;
  });

  browser.runtime.onConnect.addListener(onEventsPort);

  browser.commands.onCommand.addListener((command, tab) => {
    const action = COMMAND_ACTIONS[command];
    if (!action) return;
    void (async () => {
      const tabId = tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (tabId !== undefined) await runCommand(action, tabId);
    })().catch((error: unknown) => console.warn("[ui-annotate] command failed:", error));
  });

  const syncQuietly = () => void syncRegistrations().catch((error: unknown) => console.warn("[ui-annotate] registration sync failed:", error));
  browser.runtime.onInstalled.addListener(syncQuietly);
  browser.runtime.onStartup.addListener(syncQuietly);
  syncQuietly();

  // Exposed for e2e tests driving the service worker directly.
  Reflect.set(globalThis, "__uiAnnotate", { injectInto, syncRegistrations, isLoopbackOrigin, runCommand });
});
