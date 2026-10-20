/**
 * MAIN-world bridge. Importing element-source installs the bippy React DevTools hook, so the
 * script calling this must run at document_start, before React boots, for the hook to see
 * renderers; fiber reads themselves also work when injected later.
 * It only reads framework internals; extension APIs do not exist in this world.
 */
import { BRIDGE } from "@ui-annotate/protocol/constants";
import { resolveElement } from "./resolve.js";

const INSTALLED_FLAG = "__uiAnnotateResolverInstalled";

function respond(requestId: string, source: unknown): void {
  document.dispatchEvent(new CustomEvent(BRIDGE.responseEvent, { detail: JSON.stringify({ requestId, source }) }));
}

/** Open shadow roots are reachable from both worlds; the marker may live inside one. */
function findInShadowRoots(root: Document | ShadowRoot, selector: string): Element | null {
  for (const host of root.querySelectorAll("*")) {
    if (!host.shadowRoot) continue;
    const found = host.shadowRoot.querySelector(selector) ?? findInShadowRoots(host.shadowRoot, selector);
    if (found) return found;
  }
  return null;
}

async function handleRequest(event: Event): Promise<void> {
  const raw = (event as CustomEvent<unknown>).detail;
  if (typeof raw !== "string") return;
  let requestId: unknown;
  try {
    requestId = (JSON.parse(raw) as { requestId?: unknown }).requestId;
  } catch {
    return;
  }
  if (typeof requestId !== "string" || requestId.length > 64) return;
  const selector = `[${BRIDGE.targetAttribute}="${CSS.escape(requestId)}"]`;
  const element = document.querySelector(selector) ?? findInShadowRoots(document, selector);
  if (!element) {
    respond(requestId, { reason: "no-framework" });
    return;
  }
  respond(requestId, await resolveElement(element).catch(() => ({ reason: "no-framework" })));
}

/** Idempotent: a second injection on the same page is a no-op. */
export function installResolver(): void {
  if (Reflect.get(window, INSTALLED_FLAG)) return;
  Reflect.set(window, INSTALLED_FLAG, true);
  // moduleUrlForFile reads resource timing; the default buffer of 250 entries is full in large dev apps.
  performance.setResourceTimingBufferSize?.(5000);
  document.addEventListener(BRIDGE.requestEvent, (event) => void handleRequest(event));
  document.addEventListener(BRIDGE.pingEvent, () => document.dispatchEvent(new CustomEvent(BRIDGE.readyEvent)));
  document.dispatchEvent(new CustomEvent(BRIDGE.readyEvent));
}
