import { BRIDGE } from "@ui-annotate/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { requestSource } from "./bridge";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Plays the MAIN-world side: answers each request with whatever `answer` returns. */
function fakeResolver(answer: (requestId: string) => unknown) {
  const handler = (event: Event) => {
    const { requestId } = JSON.parse((event as CustomEvent<string>).detail) as { requestId: string };
    document.dispatchEvent(new CustomEvent(BRIDGE.responseEvent, { detail: JSON.stringify(answer(requestId)) }));
  };
  document.addEventListener(BRIDGE.requestEvent, handler);
  return () => document.removeEventListener(BRIDGE.requestEvent, handler);
}

describe("requestSource", () => {
  it("marks the element, accepts a valid answer and removes the marker", async () => {
    document.body.innerHTML = `<button>Save</button>`;
    const button = document.querySelector("button")!;
    let marked: string | null = null;
    const stop = fakeResolver((requestId) => {
      marked = button.getAttribute(BRIDGE.targetAttribute);
      return { requestId, source: { framework: "vue", componentName: "Btn", file: "src/Btn.vue", line: 3 } };
    });
    const source = await requestSource(button);
    stop();
    expect(marked).toMatch(/^r\d+/);
    expect(button.hasAttribute(BRIDGE.targetAttribute)).toBe(false);
    expect(source).toMatchObject({ framework: "vue", componentName: "Btn", file: "src/Btn.vue", line: 3, stack: [] });
  });

  it("ignores answers for other requests and malformed payloads, then times out", async () => {
    document.body.innerHTML = `<button>Save</button>`;
    const stop = fakeResolver(() => ({ requestId: "someone-else", source: { file: "evil.ts" } }));
    document.addEventListener(BRIDGE.requestEvent, (event) => {
      const { requestId } = JSON.parse((event as CustomEvent<string>).detail) as { requestId: string };
      document.dispatchEvent(new CustomEvent(BRIDGE.responseEvent, { detail: JSON.stringify({ requestId, source: { line: "1; drop" } }) }));
      document.dispatchEvent(new CustomEvent(BRIDGE.responseEvent, { detail: "not json" }));
    });
    const source = await requestSource(document.querySelector("button")!, 100);
    stop();
    expect(source).toMatchObject({ file: null, reason: "no-framework" });
  });

  it("truncates oversized strings from the page", async () => {
    document.body.innerHTML = `<button>Save</button>`;
    const stop = fakeResolver((requestId) => ({ requestId, source: { file: "a".repeat(10_000), componentName: "B".repeat(5000) } }));
    const source = await requestSource(document.querySelector("button")!);
    stop();
    expect(source.file).toHaveLength(1000);
    expect(source.componentName).toHaveLength(200);
  });
});
