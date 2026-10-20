import { afterEach, describe, expect, it } from "vitest";
import {
  SHADOW_SEPARATOR,
  buildDomContext,
  describeAccessibility,
  describeElement,
  elementPath,
  isTextLike,
  querySelectorDeep,
  uniqueSelector,
} from "./dom-context";

afterEach(() => {
  document.body.innerHTML = "";
});

const html = (markup: string) => {
  document.body.innerHTML = markup;
};

describe("describeElement", () => {
  it("quotes text of buttons, inputs and leaves; names containers by class", () => {
    html(`
      <header class="toolbar"><span>Fixture</span><button>Save</button></header>
      <input type="email" placeholder="Email" />
      <img alt="Logo" src="x.png" />
      <div class="card css-1a2b3c"><p>Body</p></div>
    `);
    expect(describeElement(document.querySelector("button")!)).toBe('button "Save"');
    expect(describeElement(document.querySelector("header")!)).toBe("header.toolbar");
    expect(describeElement(document.querySelector("input")!)).toBe('input[type=email] "Email"');
    expect(describeElement(document.querySelector("img")!)).toBe('img "Logo"');
    expect(describeElement(document.querySelector("div")!)).toBe("div.card");
  });
});

describe("uniqueSelector", () => {
  it("prefers ids and test ids", () => {
    html(`<div id="app"><button data-testid="save">Save</button><button>Other</button></div>`);
    expect(uniqueSelector(document.querySelector("#app")!)).toBe("#app");
    expect(uniqueSelector(document.querySelector("[data-testid=save]")!)).toBe('[data-testid="save"]');
  });

  it("builds a unique path with classes and nth-of-type", () => {
    html(`<main><ul><li>a</li><li class="active">b</li><li>c</li></ul><ul><li>d</li></ul></main>`);
    const items = document.querySelectorAll("li");
    for (const item of items) {
      const selector = uniqueSelector(item);
      expect(document.querySelectorAll(selector)).toHaveLength(1);
      expect(document.querySelector(selector)).toBe(item);
    }
    expect(uniqueSelector(items[1]!)).toContain("li.active");
  });

  it("ignores hashed CSS-in-JS classes", () => {
    html(`<div><p class="css-1x2y3z">a</p><p class="css-9q8w7e">b</p></div>`);
    expect(uniqueSelector(document.querySelectorAll("p")[1]!)).not.toContain("css-");
  });

  it("crosses open shadow roots and resolves back", () => {
    html(`<my-widget></my-widget>`);
    const host = document.querySelector("my-widget")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div class="inner"><button>Inside</button></div>`;
    const button = shadow.querySelector("button")!;
    const selector = uniqueSelector(button);
    expect(selector).toContain(SHADOW_SEPARATOR);
    expect(querySelectorDeep(selector)).toBe(button);
    expect(elementPath(button)).toContain("⟨shadow⟩");
  });
});

describe("elementPath", () => {
  it("keeps up to four informative ancestors", () => {
    // Five informative ancestors (shell, root, page, panel, form): the outermost is cut.
    html(`<div class="shell"><div id="root"><section class="page"><div><div class="panel"><form data-testid="login"><div><span><button>Go</button></span></div></form></div></div></section></div></div>`);
    expect(elementPath(document.querySelector("button")!)).toBe(
      "div#root > section.page > div.panel > form[data-testid=login] > button",
    );
  });
});

describe("accessibility and text", () => {
  it("reads explicit and implicit roles and names", () => {
    html(`<label for="e">E-mail</label><input id="e" aria-required="true" /><a href="/x">Docs</a><div role="tab" aria-selected="true">Tab</div>`);
    expect(describeAccessibility(document.querySelector("input")!)).toEqual({
      role: "textbox",
      name: "E-mail",
      attributes: { "aria-required": "true" },
    });
    expect(describeAccessibility(document.querySelector("a")!).role).toBe("link");
    expect(describeAccessibility(document.querySelector("[role=tab]")!)).toMatchObject({ role: "tab", attributes: { "aria-selected": "true" } });
  });

  it("detects text-like elements for the area-drag rule", () => {
    html(`<p>Text</p><div><span>child</span></div><div>direct text</div>`);
    const [p, wrapper, direct] = [...document.body.children];
    expect(isTextLike(p!)).toBe(true);
    expect(isTextLike(wrapper!)).toBe(false);
    expect(isTextLike(direct!)).toBe(true);
  });

  it("builds the full context within limits", () => {
    html(`<button style="display: inline-block">${"Very long label ".repeat(40)}</button>`);
    const context = buildDomContext(document.querySelector("button")!);
    expect(context.nearbyText!.length).toBeLessThanOrEqual(300);
    expect(context.element.length).toBeLessThanOrEqual(200);
    expect(context.computedStyles.display).toBe("inline-block");
    expect(context.boundingBox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
