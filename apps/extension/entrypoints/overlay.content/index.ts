import { createApp, type App as VueApp } from "vue";
import { browser } from "wxt/browser";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { defineContentScript } from "wxt/utils/define-content-script";
import type { OverlayMessage } from "../../lib/messages";
import { send } from "../../lib/messaging";
import App from "./App.vue";
import { createOverlayBus } from "./bus";
import css from "./style.css?inline";

const INSTALLED_FLAG = "__uiAnnotateOverlayInstalled";

/**
 * Constructable stylesheets are not subject to the page's `style-src` CSP. A browser that refuses
 * a sheet constructed in the content-script world gets a <style> element instead.
 */
function applyStyles(shadow: ShadowRoot): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = css;
    shadow.prepend(style);
  }
}

export default defineContentScript({
  matches: ["http://localhost/*", "http://127.0.0.1/*"],
  registration: "runtime",
  cssInjectionMode: "manual",
  async main(ctx) {
    if (Reflect.get(window, INSTALLED_FLAG)) return;
    Reflect.set(window, INSTALLED_FLAG, true);

    // Registered before any await: the background sends overlay.activate right after injecting.
    const bus = createOverlayBus();
    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      const message = raw as OverlayMessage;
      if (message.type === "overlay.activate") bus.emit("activate");
      if (message.type === "overlay.show") bus.emit("show");
      if (message.type === "overlay.command") bus.emit({ action: message.action });
      if (message.type === "overlay.state") sendResponse(bus.snapshot());
    });

    const ui = await createShadowRootUi<VueApp>(ctx, {
      name: "ui-annotate-overlay",
      position: "inline",
      anchor: "html",
      append: "last",
      isolateEvents: false,
      onMount(container, shadow, host) {
        applyStyles(shadow);
        const app = createApp(App, { host, bus });
        app.mount(container);
        return app;
      },
      onRemove(app) {
        app?.unmount();
      },
    });
    // Registered scripts match the whole host in Firefox (no ports in patterns): mount at load only
    // on an always-on origin, otherwise when the user asks (icon click, shortcut).
    // Not awaited: scripting.executeScript waits for main() to settle, and the command that
    // mounts the overlay is sent only after executeScript returns.
    void (async () => {
      const settings = await send({ type: "origin.get", origin: location.origin }).catch(() => null);
      if (!settings?.alwaysOn) await bus.firstCommand;
      ui.mount();
    })();
  },
});
