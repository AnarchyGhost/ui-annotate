// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReact } from "./react.js";

/**
 * Hand-written inline source map: generated line 3, column 0 → original line 7, column 5 (1-based).
 * "AAAA;;AAMI": line 1 segment (0,0,0,0); line 3 segment (gen col 0, source 0, line +6, column +4).
 */
const MAP = { version: 3, sources: ["AppToolbar.jsx"], names: [], mappings: "AAAA;;AAMI" };
const moduleCode = (body: string) =>
  `${body}\n//# sourceMappingURL=data:application/json;base64,${btoa(JSON.stringify(MAP))}\n`;

function stubFetch(code: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(code, { status: 200 })),
  );
}

function hostWithFiber(fiber: object): Element {
  document.body.innerHTML = `<header><button>Save</button></header>`;
  const button = document.querySelector("button")!;
  Reflect.set(button, "__reactFiber$test", fiber);
  return button;
}

function AppToolbar() {
  return null;
}
function App() {
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("resolveReact", () => {
  it("returns null without a fiber", async () => {
    document.body.innerHTML = `<button>x</button>`;
    expect(await resolveReact(document.querySelector("button")!)).toBeNull();
  });

  it("maps a React 19 debug stack frame through the module source map", async () => {
    stubFetch(moduleCode("line1\nline2\n  jsxDEV(\"button\")"));
    const appFiber = { tag: 0, type: App, return: null, _debugOwner: null };
    const toolbarFiber = { tag: 0, type: AppToolbar, return: appFiber, _debugOwner: appFiber };
    const host = hostWithFiber({
      tag: 5,
      type: "button",
      return: toolbarFiber,
      _debugOwner: toolbarFiber,
      _debugStack: {
        stack: [
          "Error: react-stack-top-frame",
          "    at exports.jsxDEV (http://127.0.0.1:5104/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:192:83)",
          "    at AppToolbar (http://127.0.0.1:5104/src/AppToolbar.jsx:3:5)",
          "    at Object.react_stack_bottom_frame (http://127.0.0.1:5104/node_modules/.vite/deps/react-dom_client.js?v=1:1:1)",
        ].join("\n"),
      },
    });
    const result = await resolveReact(host);
    expect(result?.componentName).toBe("AppToolbar");
    expect(result?.frames[0]).toEqual({
      file: "http://127.0.0.1:5104/src/AppToolbar.jsx",
      line: 7,
      column: 5,
      componentName: "AppToolbar",
    });
  });

  it("corrects a shifted React 18 __source through the transformed module", async () => {
    stubFetch(moduleCode("a\nb\n  lineNumber: 25,\n      columnNumber: 7"));
    performance.getEntriesByType = (() => [{ name: "http://127.0.0.1:5103/src/AppToolbar.jsx?t=1" }]) as never;
    const toolbarFiber = { tag: 0, type: AppToolbar, return: null, _debugOwner: null };
    const host = hostWithFiber({
      tag: 5,
      type: "button",
      return: toolbarFiber,
      _debugOwner: toolbarFiber,
      _debugSource: { fileName: "/home/u/p/src/AppToolbar.jsx", lineNumber: 25, columnNumber: 7 },
    });
    const result = await resolveReact(host);
    expect(result?.frames[0]).toMatchObject({ file: "/home/u/p/src/AppToolbar.jsx", line: 7 });
  });

  it("keeps __source as is when the module cannot be found", async () => {
    performance.getEntriesByType = (() => []) as never;
    const toolbarFiber = { tag: 0, type: AppToolbar, return: null, _debugOwner: null };
    const host = hostWithFiber({
      tag: 5,
      type: "button",
      return: toolbarFiber,
      _debugSource: { fileName: "/p/src/AppToolbar.jsx", lineNumber: 6, columnNumber: 7 },
    });
    const result = await resolveReact(host);
    expect(result?.frames[0]).toEqual({ file: "/p/src/AppToolbar.jsx", line: 6, column: 7, componentName: "AppToolbar" });
  });
});
