import { AnnotationInput, type Annotation } from "@ui-annotate/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeAnnotation } from "./placement";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function annotation(selector: string, box = { x: 100, y: 200, width: 80, height: 30 }): Annotation {
  const input = AnnotationInput.parse({
    kind: "element",
    comment: "c",
    targets: [{ element: "button", selector, elementPath: "", boundingBox: box, source: {} }],
    url: "http://localhost/",
    viewport: { width: 1, height: 1 },
  });
  return { ...input, id: "a", sessionId: "s", number: 1, status: "pending", resolvedBy: null, createdAt: "", updatedAt: "", thread: [] };
}

function fakeRect(element: Element, rect: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect } as DOMRect);
}

describe("placeAnnotation", () => {
  it("follows the live element", () => {
    document.body.innerHTML = `<button id="b">x</button>`;
    fakeRect(document.getElementById("b")!, { left: 10, top: 500, width: 82, height: 31 });
    expect(placeAnnotation(annotation("#b"))).toEqual({ rect: { x: 10, y: 500, width: 82, height: 31 }, attached: true });
  });

  it("falls back to the stored box when the selector now hits a different-sized element", () => {
    document.body.innerHTML = `<div id="b">x</div>`;
    fakeRect(document.getElementById("b")!, { left: 0, top: 0, width: 1200, height: 900 });
    expect(placeAnnotation(annotation("#b"))).toEqual({ rect: { x: 100, y: 200, width: 80, height: 30 }, attached: false });
  });

  it("falls back when the element is gone or the selector is invalid", () => {
    expect(placeAnnotation(annotation("#missing")).attached).toBe(false);
    expect(placeAnnotation(annotation(":::")).attached).toBe(false);
  });
});
