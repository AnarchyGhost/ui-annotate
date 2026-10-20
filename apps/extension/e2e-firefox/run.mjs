// Firefox check: injection, source resolution on vue3 and react19, delivery to the
// server. Drives system Firefox over WebDriver BiDi (Playwright cannot load extensions in Firefox).
// Usage: pnpm --filter extension e2e:firefox   (needs `pnpm build` first)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchFirefox, waitFor } from "./bidi.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "..", "..", "..");
const EXTENSION = join(here, "..", ".output", "firefox-mv3");
const CLI = join(repo, "packages", "server", "dist", "cli.js");
const SERVER_PORT = 4950;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const EXTENSION_ID = "ui-annotate@local";
const EXTENSION_UUID = "6b1d2a0e-5c4f-4b7e-9a3d-2f8e1c0b9a77";

const STRICT_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' ws:";

const CASES = [
  { fixture: "vue3", framework: "vue", componentName: "AppToolbar", file: "src/components/AppToolbar.vue", line: null },
  { fixture: "react19", framework: "react", componentName: "AppToolbar", file: "src/AppToolbar.jsx", line: 6 },
  // adoptedStyleSheets in the content-script shadow root under a strict page CSP.
  { fixture: "vue3-inspector", framework: "vue", componentName: "AppToolbar", file: "src/components/AppToolbar.vue", line: 8, csp: STRICT_CSP },
];

const children = [];
const cleanup = [];

async function isUp(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function ensureFixture(name) {
  const { url } = JSON.parse(readFileSync(join(repo, "fixtures", name, "expected.json"), "utf8"));
  if (!(await isUp(url))) {
    children.push(spawn("pnpm", ["dev"], { cwd: join(repo, "fixtures", name), stdio: "ignore", detached: false }));
    await waitFor(() => isUp(url), { timeout: 60_000, message: `${name} dev server` });
  }
  return url;
}

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "ui-annotate-ff-server-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, UI_ANNOTATE_PORT: String(SERVER_PORT), UI_ANNOTATE_DB: join(dir, "db.sqlite"), UI_ANNOTATE_TOKEN_FILE: join(dir, "token") };
  children.push(spawn(process.execPath, [CLI, "serve"], { env, stdio: "ignore" }));
  await waitFor(() => isUp(`${SERVER_URL}/health`), { message: "ui-annotate server" });
  return readFileSync(join(dir, "token"), "utf8").trim();
}

async function api(token, path) {
  const response = await fetch(`${SERVER_URL}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return response.ok ? response.json() : null;
}

const shadow = (body) => `(() => { const root = document.querySelector("ui-annotate-overlay")?.shadowRoot; if (!root) return null; ${body} })()`;

async function clickAt(ff, context, x, y) {
  await ff.send("input.performActions", {
    context,
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: Math.round(x), y: Math.round(y) },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
}

async function typeText(ff, context, text) {
  const actions = [...text].flatMap((value) => [
    { type: "keyDown", value },
    { type: "keyUp", value },
  ]);
  await ff.send("input.performActions", { context, actions: [{ type: "key", id: "keyboard", actions }] });
}

async function main() {
  const token = await startServer();
  const urls = Object.fromEntries(await Promise.all(CASES.map(async (item) => [item.fixture, await ensureFixture(item.fixture)])));

  const ff = await launchFirefox({
    port: 9333,
    systemAccess: true,
    // Fixed UUID makes the popup URL known; host permissions of MV3 are granted on install.
    prefs: { "extensions.webextensions.uuids": JSON.stringify({ [EXTENSION_ID]: EXTENSION_UUID }) },
  });
  cleanup.push(() => ff.close());
  const report = { firefox: ff.version, cases: [] };

  await ff.send("webExtension.install", { extensionData: { type: "path", path: EXTENSION } });
  const popup = await ff.openPrivilegedTab(`moz-extension://${EXTENSION_UUID}/popup.html`);
  await waitFor(() => ff.evaluate(popup, `typeof browser !== "undefined" && document.readyState === "complete"`), { message: "popup page" });
  // No token: the extension pairs with the test daemon through POST /pair on first use.
  await ff.evaluate(popup, `browser.storage.local.set({ settings: { serverUrl: ${JSON.stringify(SERVER_URL)}, token: "", origins: {} } }).then(() => true)`);

  const only = process.env.FF_CASES?.split(",");
  for (const expected of CASES.filter((item) => !only || only.includes(item.fixture))) {
    const url = urls[expected.fixture];
    if (expected.csp) await ff.addResponseHeaders(url, { "content-security-policy": expected.csp });
    const { context: page } = await ff.send("browsingContext.create", { type: "tab" });
    await ff.send("browsingContext.navigate", { context: page, url, wait: "complete" });
    await waitFor(() => ff.evaluate(page, `!!document.querySelector("[data-testid=save]")`), { message: "fixture render" });
    if (expected.csp) {
      const inlineApplied = await ff.evaluate(
        page,
        `(() => { const s = document.createElement("style"); s.textContent = "body { outline: 7px solid rgb(1, 2, 3); }"; document.head.append(s); return getComputedStyle(document.body).outlineWidth === "7px"; })()`,
      );
      assert.equal(inlineApplied, false, "control: the page CSP blocks inline styles");
    }

    const activated = await ff.evaluate(
      popup,
      // Match patterns cannot carry a port, so the tab is found by its URL.
      `browser.tabs.query({}).then((tabs) => browser.runtime.sendMessage({ type: "tab.activate", tabId: tabs.findLast((tab) => tab.url?.startsWith(${JSON.stringify(url)})).id }))`,
    );
    assert.equal(activated?.ok, true, `tab.activate failed: ${JSON.stringify(activated)}`);

    await waitFor(() => ff.evaluate(page, shadow(`return root.querySelector('[data-testid="ua-status"]')?.dataset.state === "online"`)), {
      message: "overlay online",
    });
    const pressed = await ff.evaluate(page, shadow(`return root.querySelector('[data-testid="ua-annotate"]').getAttribute("aria-pressed")`));
    assert.equal(pressed, "true", "annotate mode is on");
    const styles = await ff.evaluate(
      page,
      shadow(`return { adopted: root.adoptedStyleSheets.length, styleElements: root.querySelectorAll("style").length, toolbarPosition: getComputedStyle(root.querySelector('[data-testid="ua-toolbar"]')).position }`),
    );
    assert.equal(styles.toolbarPosition, "fixed", "overlay CSS applied");

    const target = await ff.evaluate(page, `(() => { const r = document.querySelector("[data-testid=save]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await clickAt(ff, page, target.x, target.y);
    await waitFor(() => ff.evaluate(page, shadow(`return !!root.querySelector('[data-testid="ua-editor"]')`)), { message: "editor" });
    const clickedPage = await ff.evaluate(page, `window.__uiAnnotatePageClick ?? false`);
    await typeText(ff, page, "Firefox check");
    await typeText(ff, page, "");
    await waitFor(() => ff.evaluate(page, shadow(`return !!root.querySelector('[data-testid="ua-marker-1"]')`)), { message: "marker" });

    const session = await api(token, `/sessions?url=${encodeURIComponent(url)}`);
    const [annotation] = await api(token, `/sessions/${session.id}/annotations`);
    const source = annotation.targets[0].source;
    if (!source.file) console.error("diagnostics", JSON.stringify({ resolver: await ff.evaluate(page, "!!window.__uiAnnotateResolverInstalled"), source }));
    const file = source.file?.replace(/^.*\/fixtures\/[^/]+\//, "").replace(/^https?:\/\/[^/]+\//, "");
    const actual = { framework: source.framework, componentName: source.componentName, file, line: source.line };
    report.cases.push({ fixture: expected.fixture, csp: expected.csp ?? null, styles, actual, pageClickBlocked: !clickedPage });
    assert.deepEqual(actual, { framework: expected.framework, componentName: expected.componentName, file: expected.file, line: expected.line });
    assert.equal(annotation.comment, "Firefox check");
  }

  // Always-on in Firefox: registrations match the host without a port, the overlay mounts only on
  // the enabled origin (vue3 on :5101), not on another port of the same host (react19 on :5104).
  const enabled = await ff.evaluate(
    popup,
    `browser.runtime.sendMessage({ type: "origin.set", origin: ${JSON.stringify(new URL(urls.vue3).origin)}, settings: { alwaysOn: true } }).then((r) => r.ok)`,
  );
  assert.equal(enabled, true, "always-on registration");
  const { context: alwaysOnPage } = await ff.send("browsingContext.create", { type: "tab" });
  await ff.send("browsingContext.navigate", { context: alwaysOnPage, url: urls.vue3, wait: "complete" });
  await waitFor(() => ff.evaluate(alwaysOnPage, shadow(`return !!root.querySelector('[data-testid="ua-toolbar"]')`)), {
    message: "overlay mounted by the always-on registration",
  });
  const { context: otherPortPage } = await ff.send("browsingContext.create", { type: "tab" });
  await ff.send("browsingContext.navigate", { context: otherPortPage, url: urls.react19, wait: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await ff.evaluate(otherPortPage, `!!document.querySelector("ui-annotate-overlay")`), false, "no overlay on another port");
  report.alwaysOn = { enabledOrigin: "mounted", otherPort: "not mounted" };

  // Real key presses through the browser keyset (Firefox also hands them to the page): Ctrl+Shift+F
  // shows, hides and shows the overlay; Ctrl+Shift+1 toggles annotation mode. No page reloads.
  {
    const { context: shortcutPage } = await ff.send("browsingContext.create", { type: "tab" });
    await ff.send("browsingContext.navigate", { context: shortcutPage, url: urls.react19, wait: "complete" });
    await ff.send("browsingContext.activate", { context: shortcutPage });
    const chromeContext = (await ff.send("browsingContext.getTree", { "moz:scope": "chrome" })).contexts[0].context;
    const press = (key, code, keyCodeName) =>
      ff.evaluate(
        chromeContext,
        `(() => {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
          tip.beginInputTransactionForTests(win);
          const KE = win.KeyboardEvent;
          const keys = [["Control", "ControlLeft", KE.DOM_VK_CONTROL], ["Shift", "ShiftLeft", KE.DOM_VK_SHIFT], [${JSON.stringify(key)}, ${JSON.stringify(code)}, KE.${keyCodeName}]].map(([key, code, keyCode]) => new KE("", { key, code, keyCode }));
          for (const key of keys) tip.keydown(key);
          for (const key of keys.reverse()) tip.keyup(key);
          return true;
        })()`,
      );
    const overlayState = () =>
      ff.evaluate(
        shortcutPage,
        `(() => { const root = document.querySelector("ui-annotate-overlay")?.shadowRoot; const button = root?.querySelector('[data-testid="ua-annotate"]'); return button ? "shown:" + button.getAttribute("aria-pressed") : "hidden"; })()`,
      );
    const steps = [
      ["F", "KeyF", "DOM_VK_F"],
      ["F", "KeyF", "DOM_VK_F"],
      ["F", "KeyF", "DOM_VK_F"],
      ["!", "Digit1", "DOM_VK_1"],
      ["!", "Digit1", "DOM_VK_1"],
    ];
    const states = [];
    for (const step of steps) {
      await press(...step);
      await new Promise((resolve) => setTimeout(resolve, 900));
      states.push(await overlayState());
    }
    assert.deepEqual(states, ["shown:false", "hidden", "shown:false", "shown:true", "shown:false"], `after each shortcut: ${states}`);
    report.shortcuts = states;
  }

  // With host access granted the popup reports the connection (the server URL carries a port,
  // which a match pattern must not).
  await ff.send("browsingContext.reload", { context: popup, wait: "complete" });
  const statusText = `document.querySelector('[data-testid="popup-status"]')?.textContent.trim()`;
  const connected = await waitFor(
    () => ff.evaluate(popup, `(() => { const text = ${statusText}; return text && text !== "Checking…" ? text : null; })()`),
    { message: "popup status" },
  );
  assert.equal(connected, "Connected", `popup status with access: ${connected}`);

  // A Firefox install can be enabled without host access (seen in Zen with a sideloaded xpi):
  // the popup must say so and offer the permission prompt instead of "server offline".
  await ff.evaluate(popup, `browser.permissions.remove({ origins: ["http://127.0.0.1/*", "http://localhost/*"] })`);
  await ff.send("browsingContext.reload", { context: popup, wait: "complete" });
  const hostAccessCard = await waitFor(
    () => ff.evaluate(popup, `document.querySelector('[data-testid="popup-host-access"] [data-testid="popup-grant"]') ? ${statusText} : null`),
    { message: "host access card in the popup" },
  );
  assert.equal(hostAccessCard, "No access to localhost");
  report.hostAccessMissing = hostAccessCard;

  console.log(JSON.stringify(report, null, 2));
  console.log("firefox e2e: ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const step of cleanup.reverse()) await step();
    for (const child of children) child.kill();
  });
