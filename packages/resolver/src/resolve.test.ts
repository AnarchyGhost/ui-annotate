// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { parseAttributeValue, readAttributeLocation, resolveElement } from "./index.js";

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "ng");
  document.documentElement.removeAttribute("ng-version");
});

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.querySelector("[data-target]") ?? document.body.firstElementChild!;
}

describe("attributes", () => {
  it.each([
    ["data-insp-path", "/home/u/p/src/App.vue:12:5:button", { file: "/home/u/p/src/App.vue", line: 12, column: 5 }],
    ["data-v-inspector", "src/App.vue:7:3", { file: "src/App.vue", line: 7, column: 3 }],
    ["data-locatorjs", "/home/u/p/src/App.tsx:4:0", { file: "/home/u/p/src/App.tsx", line: 4, column: 1 }],
    ["data-source-loc", "src/App.tsx:9:11", { file: "src/App.tsx", line: 9, column: 11 }],
  ])("parses %s", (name, value, expected) => {
    expect(readAttributeLocation(el(`<div ${name}="${value}"><span data-target></span></div>`))).toEqual({
      attribute: name,
      ...expected,
    });
  });

  it("keeps Windows drive letters in the path", () => {
    const spec = { name: "data-v-inspector", trailing: 0, zeroBasedColumn: false, readProperty: false };
    expect(parseAttributeValue(spec, "C:/p/src/App.vue:3:1")?.file).toBe("C:/p/src/App.vue");
  });

  it("rejects malformed values", () => {
    expect(readAttributeLocation(el(`<div data-v-inspector="garbage"></div>`))).toBeNull();
    expect(readAttributeLocation(el(`<div data-v-inspector="a.vue:x:1"></div>`))).toBeNull();
  });

  it("reads code-inspector property form", () => {
    const element = el(`<div></div>`);
    Reflect.set(element, "data-insp-path", "src/A.vue:2:3:div");
    expect(readAttributeLocation(element)?.line).toBe(2);
  });

  it("reads vite-plugin-vue-inspector 7 hidden vnode prop", () => {
    const element = el(`<div><button data-target></button></div>`);
    const props = {};
    Object.defineProperty(props, "__v_inspector", { value: "src/Btn.vue:8:5", enumerable: false });
    Reflect.set(element, "__vnode", { props });
    expect(readAttributeLocation(element)).toEqual({ attribute: "data-v-inspector", file: "src/Btn.vue", line: 8, column: 5 });
  });

  it("reads vite-plugin-vue-inspector 7 global store", () => {
    const element = el(`<div><button data-target></button></div>`);
    const props = {};
    const vnodeToPos = new WeakMap([[props, ["src/Btn.vue", 9, 4]]]);
    Reflect.set(globalThis, "__vue_inspector_store__", { vnodeToPos });
    Reflect.set(element, "__vnode", { props });
    expect(readAttributeLocation(element)?.line).toBe(9);
    Reflect.deleteProperty(globalThis, "__vue_inspector_store__");
  });

  it("prefers the nearest element", () => {
    const element = el(`<div data-v-inspector="src/Outer.vue:1:1"><p data-v-inspector="src/Inner.vue:5:2"><b data-target></b></p></div>`);
    expect(readAttributeLocation(element)?.file).toBe("src/Inner.vue");
  });
});

describe("resolveElement", () => {
  it("reports no-framework on a plain page", async () => {
    const source = await resolveElement(el(`<button>ok</button>`));
    expect(source).toMatchObject({ framework: null, file: null, reason: "no-framework" });
  });

  it("resolves Vue component without a line", async () => {
    const element = el(`<div><button data-target>Save</button></div>`);
    const parent = { type: { __name: "AppShell", __file: "/home/u/p/src/AppShell.vue" }, parent: null };
    const component = { type: { __name: "SaveButton", __file: "/home/u/p/src/SaveButton.vue" }, parent };
    Reflect.set(element, "__vueParentComponent", component);
    const source = await resolveElement(element);
    expect(source).toMatchObject({
      framework: "vue",
      componentName: "SaveButton",
      file: "/home/u/p/src/SaveButton.vue",
      line: null,
      via: "runtime",
      reason: "no-line",
    });
    expect(source.stack.map((frame) => frame.componentName)).toEqual(["SaveButton", "AppShell"]);
  });

  it("takes the line from a build-plugin attribute over Vue runtime", async () => {
    const element = el(`<div><button data-target data-v-inspector="src/SaveButton.vue:4:3">Save</button></div>`);
    Reflect.set(element, "__vueParentComponent", { type: { __name: "SaveButton", __file: "/x/src/SaveButton.vue" } });
    const source = await resolveElement(element);
    expect(source).toMatchObject({
      framework: "vue",
      componentName: "SaveButton",
      file: "src/SaveButton.vue",
      line: 4,
      column: 3,
      via: "attribute",
      attribute: "data-v-inspector",
      reason: null,
    });
  });

  it("resolves Svelte 5 meta with 1-based lines", async () => {
    const element = el(`<p data-target>hi</p>`);
    Reflect.set(element, "__svelte_meta", {
      loc: { file: "src/lib/Card.svelte", line: 3, column: 2 },
      parent: { type: "component", file: "src/App.svelte", line: 10, column: 0, componentTag: "Card", parent: null },
    });
    const source = await resolveElement(element);
    expect(source).toMatchObject({ framework: "svelte", file: "src/lib/Card.svelte", line: 3, column: 3, componentName: "Card" });
  });

  it("shifts Svelte 4 0-based lines", async () => {
    const element = el(`<p data-target>hi</p>`);
    Reflect.set(element, "__svelte_meta", { loc: { file: "src/Card.svelte", line: 2, column: 4, char: 30 } });
    const source = await resolveElement(element);
    expect(source).toMatchObject({ framework: "svelte", file: "src/Card.svelte", line: 3, column: 5 });
  });

  it("resolves Angular through window.ng and ɵcmp.debugInfo", async () => {
    const host = el(`<app-root><app-card><span data-target>x</span></app-card></app-root>`);
    const appRoot = document.querySelector("app-root")!;
    const appCard = document.querySelector("app-card")!;
    class AppComponent {}
    class CardComponent {}
    Reflect.set(AppComponent, "ɵcmp", { debugInfo: { className: "AppComponent", filePath: "src/app/app.component.ts", lineNumber: 8 } });
    Reflect.set(CardComponent, "ɵcmp", { debugInfo: { className: "CardComponent", filePath: "src/app/card.component.ts", lineNumber: 5 } });
    const card = new CardComponent();
    const app = new AppComponent();
    Reflect.set(window, "ng", {
      getComponent: (element: Element) => (element === appCard ? card : element === appRoot ? app : null),
      getOwningComponent: (element: Element) => (element === appCard ? app : element === appRoot ? null : card),
      getHostElement: (component: object) => (component === card ? appCard : component === app ? appRoot : null),
    });
    const source = await resolveElement(host);
    expect(source).toMatchObject({
      framework: "angular",
      componentName: "CardComponent",
      file: "src/app/card.component.ts",
      line: 5,
      via: "runtime",
    });
    expect(source.stack.map((frame) => frame.componentName)).toEqual(["CardComponent", "AppComponent"]);
  });

  it("flags a production Vue build", async () => {
    const element = el(`<div id="app"><b data-target>x</b></div>`);
    Reflect.set(document.getElementById("app")!, "__vue_app__", {});
    const source = await resolveElement(element);
    expect(source).toMatchObject({ framework: "vue", file: null, reason: "production-build" });
  });

  it("flags a production Angular build", async () => {
    document.documentElement.setAttribute("ng-version", "20.0.0");
    const source = await resolveElement(el(`<span data-target>x</span>`));
    expect(source).toMatchObject({ framework: "angular", reason: "production-build" });
  });
});
