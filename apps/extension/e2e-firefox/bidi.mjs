// Minimal WebDriver BiDi client for Firefox: launch, install the extension, evaluate, input.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function launchFirefox({ port, prefs = {}, headless = true, systemAccess = false, binary = process.env.FIREFOX_BIN ?? "firefox" }) {
  const profile = mkdtempSync(join(tmpdir(), "ui-annotate-ff-"));
  const base = {
    "xpinstall.signatures.required": false,
    "browser.shell.checkDefaultBrowser": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.aboutwelcome.enabled": false,
    ...prefs,
  };
  writeFileSync(join(profile, "user.js"), Object.entries(base).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
  const flags = [...(headless ? ["--headless"] : []), ...(systemAccess ? ["--remote-allow-system-access"] : [])];
  const proc = spawn(binary, [...flags, "--no-remote", "--profile", profile, `--remote-debugging-port=${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let version = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Firefox did not open WebDriver BiDi in 30 s")), 30_000);
    proc.stderr.on("data", (chunk) => {
      if (String(chunk).includes("WebDriver BiDi listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once("exit", (code) => reject(new Error(`Firefox exited with ${code}`)));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "event") {
      for (const listener of listeners.get(message.method) ?? []) void listener(message.params);
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.type === "error") reject(new Error(`${message.error}: ${message.message}`));
    else resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const session = await send("session.new", { capabilities: {} });
  version = session.capabilities.browserVersion;

  /** Evaluates `expression` (awaiting promises) in the context and returns a plain JS value. */
  const evaluate = async (context, expression) => {
    const result = await send("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: "none" });
    if (result.type === "exception") throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
    return decode(result.result);
  };

  /**
   * Opens a privileged URL (moz-extension://…) in a new tab from the parent process: BiDi
   * navigation refuses extension URLs. Needs `systemAccess`. Returns the tab's context id.
   */
  const openPrivilegedTab = async (url) => {
    const tree = await send("browsingContext.getTree", { "moz:scope": "chrome" });
    const chrome = tree.contexts[0].context;
    await evaluate(
      chrome,
      `(() => { const tab = gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); gBrowser.selectedTab = tab; return true; })()`,
    );
    return waitFor(async () => {
      const { contexts } = await send("browsingContext.getTree", {});
      return contexts.find((context) => context.url === url)?.context ?? null;
    }, { message: `tab ${url}` });
  };

  const close = async () => {
    try {
      await send("browser.close");
    } catch {
      // Browser already gone.
    }
    ws.close();
    proc.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(profile, { recursive: true, force: true });
  };
  const on = async (method, listener) => {
    if (!listeners.has(method)) {
      listeners.set(method, []);
      await send("session.subscribe", { events: [method] });
    }
    listeners.get(method).push(listener);
  };

  /** Adds response headers to every document response from `url` (exact match). */
  const addResponseHeaders = async (url, headers) => {
    await send("network.addIntercept", { phases: ["responseStarted"], urlPatterns: [{ type: "string", pattern: url }] });
    await on("network.responseStarted", async (params) => {
      if (!params.isBlocked) return;
      const existing = params.response.headers.filter((header) => !Object.keys(headers).includes(header.name.toLowerCase()));
      await send("network.continueResponse", {
        request: params.request.request,
        headers: [...existing, ...Object.entries(headers).map(([name, value]) => ({ name, value: { type: "string", value } }))],
      });
    });
  };

  return { send, evaluate, on, addResponseHeaders, openPrivilegedTab, close, version };
}

function decode(value) {
  switch (value.type) {
    case "undefined":
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "array":
      return value.value.map(decode);
    case "object":
      return Object.fromEntries(value.value.map(([key, item]) => [typeof key === "string" ? key : decode(key), decode(item)]));
    default:
      return value.value ?? null;
  }
}

export async function waitFor(check, { timeout = 10_000, interval = 150, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
