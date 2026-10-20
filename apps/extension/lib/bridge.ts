import { BRIDGE, BridgeResponse, SourceInfo } from "@ui-annotate/protocol";

const TIMEOUT_MS = 4000;

const unknownSource = (): SourceInfo => SourceInfo.parse({ reason: "no-framework" });

function newRequestId(): string {
  return `r${crypto.getRandomValues(new Uint32Array(2)).join("")}`;
}

/**
 * Asks the MAIN-world resolver for the source of `element`. The answer is untrusted page data:
 * the request id is visible to the page (attribute and event), so the page can answer first with
 * anything. The id only separates concurrent requests; the schema validates and truncates, and
 * the server and the formatters treat source fields as page data (paths checked, text flattened).
 */
export function requestSource(element: Element, timeoutMs = TIMEOUT_MS): Promise<SourceInfo> {
  return new Promise((resolve) => {
    const requestId = newRequestId();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (source: SourceInfo) => {
      if (timer) clearTimeout(timer);
      document.removeEventListener(BRIDGE.responseEvent, onResponse);
      if (element.getAttribute(BRIDGE.targetAttribute) === requestId) element.removeAttribute(BRIDGE.targetAttribute);
      resolve(source);
    };
    const onResponse = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== "string") return;
      let payload: unknown;
      try {
        payload = JSON.parse(detail);
      } catch {
        return;
      }
      const parsed = BridgeResponse.safeParse(payload);
      if (!parsed.success || parsed.data.requestId !== requestId) return;
      finish(parsed.data.source);
    };
    document.addEventListener(BRIDGE.responseEvent, onResponse);
    timer = setTimeout(() => finish(unknownSource()), timeoutMs);
    element.setAttribute(BRIDGE.targetAttribute, requestId);
    document.dispatchEvent(new CustomEvent(BRIDGE.requestEvent, { detail: JSON.stringify({ requestId }) }));
  });
}

/** True when the MAIN-world resolver answers a ping. */
export function pingResolver(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      document.removeEventListener(BRIDGE.readyEvent, onReady);
      resolve(false);
    }, timeoutMs);
    document.addEventListener(BRIDGE.readyEvent, onReady, { once: true });
    document.dispatchEvent(new CustomEvent(BRIDGE.pingEvent));
  });
}
