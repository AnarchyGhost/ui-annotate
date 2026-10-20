import { LIMITS, type Rect } from "@ui-annotate/protocol";
import { isTextLike } from "./dom-context";

export type PickKind = "element" | "text" | "multi" | "area";

export interface Pick {
  kind: PickKind;
  elements: Element[];
  selectedText: string | null;
  /** Viewport rectangle of an area pick. */
  area: Rect | null;
  /** Viewport point where the editor should appear. */
  anchor: { x: number; y: number };
}

export interface PickerCallbacks {
  onHover(element: Element | null): void;
  onMultiChange(elements: Element[]): void;
  onAreaChange(rect: Rect | null): void;
  onPick(pick: Pick): void;
}

const DRAG_THRESHOLD_PX = 6;
/**
 * Blocked by `onBlocked`. click, mousedown and mouseup are blocked inside their own handlers:
 * stopImmediatePropagation in one window listener would starve the next one on window.
 */
const BLOCKED_EVENTS = ["dblclick", "auxclick", "pointerdown", "pointerup", "touchstart", "touchend"] as const;
const SKIPPED_TAGS = new Set(["HTML", "BODY", "SCRIPT", "STYLE", "LINK", "META", "HEAD", "NOSCRIPT", "TEMPLATE"]);

const isModifier = (event: MouseEvent) => event.metaKey || event.ctrlKey;

function deepElementsFromPoint(x: number, y: number): Element[] {
  const result: Element[] = [];
  const visit = (root: Document | ShadowRoot) => {
    for (const element of root.elementsFromPoint(x, y)) {
      if (result.includes(element)) continue;
      result.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return result;
}

const area = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return rect.width * rect.height;
};

function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function inside(rect: DOMRect, box: Rect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.left >= box.x && rect.top >= box.y && rect.right <= box.x + box.width && rect.bottom <= box.y + box.height;
}

/**
 * Page-side selection: hover highlight, click, Cmd/Ctrl+click multi-select, area drag and text
 * selection. While active, page handlers do not see pointer events: listeners run in the window
 * capture phase and stop propagation. Text selection keeps working because mousedown on text is
 * never default-prevented. Synthetic events from page scripts (`isTrusted === false`) never pick.
 */
export class Picker {
  private active = false;
  private multi: Element[] = [];
  private dragStart: { x: number; y: number } | null = null;
  private dragging = false;
  private suppressNextClick = false;
  /** The current left-button press started on text: only then a selection becomes a text pick. */
  private downOnText = false;
  private previousUserSelect = "";

  constructor(
    private readonly host: Element,
    private readonly callbacks: PickerCallbacks,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get multiSelection(): Element[] {
    return [...this.multi];
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.suppressNextClick = false;
    this.downOnText = false;
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, this.onBlocked, { capture: true });
    window.addEventListener("pointermove", this.onMove, { capture: true });
    window.addEventListener("mousedown", this.onDown, { capture: true });
    window.addEventListener("mousemove", this.onDrag, { capture: true });
    window.addEventListener("mouseup", this.onUp, { capture: true });
    window.addEventListener("click", this.onClick, { capture: true });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, this.onBlocked, { capture: true });
    window.removeEventListener("pointermove", this.onMove, { capture: true });
    window.removeEventListener("mousedown", this.onDown, { capture: true });
    window.removeEventListener("mousemove", this.onDrag, { capture: true });
    window.removeEventListener("mouseup", this.onUp, { capture: true });
    window.removeEventListener("click", this.onClick, { capture: true });
    this.cancelDrag();
    this.suppressNextClick = false;
    this.callbacks.onHover(null);
  }

  clearMulti(): void {
    this.multi = [];
    this.callbacks.onMultiChange([]);
  }

  /** Opens the editor for the collected Cmd/Ctrl+click selection. */
  commitMulti(): void {
    if (this.multi.length === 0) return;
    const last = this.multi.at(-1)!.getBoundingClientRect();
    const elements = [...this.multi];
    this.clearMulti();
    this.callbacks.onPick({ kind: elements.length > 1 ? "multi" : "element", elements, selectedText: null, area: null, anchor: { x: last.right, y: last.bottom } });
  }

  private isOverlay(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  private targetOf(event: Event): Element | null {
    const first = event.composedPath()[0];
    let element = first instanceof Element ? first : first instanceof Node ? first.parentElement : null;
    while (element && SKIPPED_TAGS.has(element.tagName) && element.tagName !== "HTML") element = element.parentElement;
    if (!element || SKIPPED_TAGS.has(element.tagName) || element === this.host) return null;
    return element;
  }

  /** Smallest element under the pointer, through overlapping layers and open shadow roots. */
  private piercingTarget(x: number, y: number): Element | null {
    const candidates = deepElementsFromPoint(x, y).filter(
      (element) => element !== this.host && !this.host.contains(element) && !SKIPPED_TAGS.has(element.tagName),
    );
    return candidates.sort((a, b) => area(a) - area(b))[0] ?? null;
  }

  private onBlocked = (event: Event) => {
    if (this.isOverlay(event)) return;
    event.stopImmediatePropagation();
    if (event.type === "dblclick" || event.type === "auxclick") event.preventDefault();
  };

  private onMove = (event: PointerEvent) => {
    if (!event.isTrusted) return;
    if (this.isOverlay(event) || this.dragging) return;
    this.callbacks.onHover(this.targetOf(event));
  };

  private onDown = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (this.isOverlay(event)) return;
    event.stopImmediatePropagation();
    if (event.button !== 0) return;
    const target = this.targetOf(event);
    this.downOnText = target !== null && isTextLike(target);
    if (isModifier(event) || event.shiftKey || !target || this.downOnText) return;
    this.dragStart = { x: event.clientX, y: event.clientY };
    // Non-text target: no native selection to keep, and default would start one across the page.
    // preventDefault would also keep an older selection alive, so it is dropped here.
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
  };

  /** Swallow the click that follows this mouseup, and only that one. */
  private suppressFollowingClick(): void {
    this.suppressNextClick = true;
    setTimeout(() => (this.suppressNextClick = false), 0);
  }

  private onDrag = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (!this.dragStart) return;
    const distance = Math.hypot(event.clientX - this.dragStart.x, event.clientY - this.dragStart.y);
    if (!this.dragging && distance < DRAG_THRESHOLD_PX) return;
    if (!this.dragging) {
      this.dragging = true;
      this.previousUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.userSelect = "none";
      this.callbacks.onHover(null);
    }
    this.callbacks.onAreaChange(normalizeRect(this.dragStart.x, this.dragStart.y, event.clientX, event.clientY));
  };

  private onUp = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (!this.isOverlay(event)) event.stopImmediatePropagation();
    if (event.button !== 0) return;
    const startedOnText = this.downOnText;
    this.downOnText = false;
    if (this.dragging && this.dragStart) {
      const box = normalizeRect(this.dragStart.x, this.dragStart.y, event.clientX, event.clientY);
      this.cancelDrag();
      this.suppressFollowingClick();
      const elements = this.elementsInside(box);
      if (elements.length > 0) {
        this.callbacks.onPick({ kind: "area", elements, selectedText: null, area: box, anchor: { x: box.x + box.width, y: box.y + box.height } });
      }
      return;
    }
    this.cancelDrag();
    if (this.isOverlay(event) || !startedOnText) return;
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString().trim() : "";
    if (!text || !selection) return;
    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const element = common instanceof Element ? common : common.parentElement;
    if (!element || this.host.contains(element)) return;
    this.suppressFollowingClick();
    const rect = range.getBoundingClientRect();
    this.callbacks.onPick({
      kind: "text",
      elements: [element],
      selectedText: text.slice(0, LIMITS.selectedText),
      area: null,
      anchor: { x: rect.right, y: rect.bottom },
    });
  };

  private onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (this.isOverlay(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (isModifier(event)) {
      const target = this.piercingTarget(event.clientX, event.clientY);
      if (!target) return;
      this.multi = this.multi.includes(target) ? this.multi.filter((item) => item !== target) : [...this.multi, target].slice(0, LIMITS.targets);
      this.callbacks.onMultiChange([...this.multi]);
      return;
    }
    const target = this.targetOf(event);
    if (!target) return;
    if (this.multi.length > 0) {
      if (!this.multi.includes(target)) this.multi.push(target);
      this.commitMulti();
      return;
    }
    this.callbacks.onPick({ kind: "element", elements: [target], selectedText: null, area: null, anchor: { x: event.clientX, y: event.clientY } });
  };

  private cancelDrag(): void {
    if (this.dragging) document.documentElement.style.userSelect = this.previousUserSelect;
    this.dragStart = null;
    this.dragging = false;
    this.callbacks.onAreaChange(null);
  }

  /** Outermost visible elements fully inside the box. */
  private elementsInside(box: Rect): Element[] {
    const chosen: Element[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      if (chosen.length >= LIMITS.targets) break;
      if (element === this.host || this.host.contains(element) || SKIPPED_TAGS.has(element.tagName)) continue;
      if (chosen.some((parent) => parent.contains(element))) continue;
      if (inside(element.getBoundingClientRect(), box)) chosen.push(element);
    }
    return chosen;
  }
}
