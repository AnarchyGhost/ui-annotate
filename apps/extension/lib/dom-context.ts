import { LIMITS, type Accessibility, type Rect } from "@ui-annotate/protocol";

/** DOM context of one annotated element; the source location is added by the resolver. */
export interface DomContext {
  element: string;
  selector: string;
  elementPath: string;
  nearbyText: string | null;
  computedStyles: Record<string, string>;
  accessibility: Accessibility;
  boundingBox: Rect;
}

/** Separator between selectors of the host document and of an open shadow root. */
export const SHADOW_SEPARATOR = " >>> ";
const MAX_PATH_ANCESTORS = 4;

const TEXT_TAGS = new Set(["P", "SPAN", "A", "LABEL", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "STRONG", "EM", "B", "I", "SMALL", "BLOCKQUOTE", "CODE", "PRE"]);
const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

const BASE_STYLES = ["display", "position", "width", "height", "margin", "padding", "color", "background-color", "border", "border-radius", "opacity", "z-index"];
const TEXT_STYLES = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-decoration-line", "white-space"];
const LAYOUT_STYLES = ["flex-direction", "justify-content", "align-items", "gap", "grid-template-columns", "overflow"];
const FORM_STYLES = ["font-size", "font-weight", "cursor", "outline", "box-shadow"];

const IMPLICIT_ROLES: Record<string, string> = {
  A: "link",
  BUTTON: "button",
  NAV: "navigation",
  MAIN: "main",
  HEADER: "banner",
  FOOTER: "contentinfo",
  ASIDE: "complementary",
  FORM: "form",
  SECTION: "region",
  UL: "list",
  OL: "list",
  LI: "listitem",
  TABLE: "table",
  IMG: "img",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  TEXTAREA: "textbox",
  SELECT: "combobox",
  DIALOG: "dialog",
};

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const squash = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** Classes produced by CSS-in-JS and scoped styles say nothing to a human or an agent. */
function meaningfulClasses(element: Element): string[] {
  return [...element.classList].filter(
    (name) => !/^(css|sc|jsx|svelte|emotion|chakra)-[\w-]+$/.test(name) && !/^[a-z]{1,3}-?[0-9a-f]{5,}$/i.test(name) && !/^_[\w-]+_[\w]{5}$/.test(name),
  );
}

function textOf(element: Element): string {
  const own = element instanceof HTMLElement ? element.innerText ?? element.textContent : element.textContent;
  return squash(own);
}

function implicitRole(element: Element): string | null {
  if (element.tagName === "INPUT") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "range") return "slider";
    return "textbox";
  }
  if (element.tagName === "A" && !element.hasAttribute("href")) return null;
  return IMPLICIT_ROLES[element.tagName] ?? null;
}

function accessibleName(element: Element): string | null {
  const label = element.getAttribute("aria-label");
  if (label) return squash(label);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => root.getElementById?.(id)?.textContent ?? "")
      .join(" ");
    if (squash(text)) return squash(text);
  }
  if (element instanceof HTMLImageElement && element.alt) return squash(element.alt);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const labels = element.labels ? [...element.labels].map((item) => item.textContent ?? "").join(" ") : "";
    if (squash(labels)) return squash(labels);
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return squash(placeholder);
  }
  const text = textOf(element);
  return text ? clip(text, 80) : null;
}

export function describeAccessibility(element: Element): Accessibility {
  const attributes: Record<string, string> = {};
  for (const attribute of element.attributes) {
    if (attribute.name.startsWith("aria-") && Object.keys(attributes).length < LIMITS.ariaEntries) {
      attributes[attribute.name] = clip(attribute.value, LIMITS.styleValue);
    }
  }
  return {
    role: element.getAttribute("role") ?? implicitRole(element),
    name: (() => {
      const name = accessibleName(element);
      return name ? clip(name, LIMITS.element) : null;
    })(),
    attributes,
  };
}

/** Human-readable name: `button "Save"`, `input[type=email] "Email"`, `div.card`. */
export function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  let head = tag;
  if (element instanceof HTMLInputElement) head = `input[type=${element.type || "text"}]`;
  const classes = meaningfulClasses(element).slice(0, 2);
  const name = accessibleName(element);
  // Containers are named by class: their text is the children's text glued together.
  const quotable =
    FORM_TAGS.has(element.tagName) ||
    TEXT_TAGS.has(element.tagName) ||
    element.tagName === "IMG" ||
    element.hasAttribute("aria-label") ||
    element.childElementCount === 0;
  const label = name && quotable ? ` "${clip(name, 60)}"` : "";
  const base = label ? head : `${head}${element.id ? `#${element.id}` : ""}${classes.map((item) => `.${item}`).join("")}`;
  return clip(`${base}${label}`, LIMITS.element);
}

function isUnique(root: Document | ShadowRoot, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function segmentFor(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tag;
  const sameTag = [...parent.children].filter((child) => child.tagName === element.tagName);
  if (sameTag.length === 1) return tag;
  const classes = meaningfulClasses(element);
  for (const name of classes) {
    const withClass = sameTag.filter((child) => child.classList.contains(name));
    if (withClass.length === 1) return `${tag}.${CSS.escape(name)}`;
  }
  return `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

/** Unique selector inside the element's own root (document or open shadow root). */
function selectorInRoot(element: Element): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  if (element.id && isUnique(root, `#${CSS.escape(element.id)}`)) return `#${CSS.escape(element.id)}`;
  for (const attribute of ["data-testid", "data-test", "data-cy", "data-qa"]) {
    const value = element.getAttribute(attribute);
    if (value) {
      const selector = `[${attribute}="${CSS.escape(value)}"]`;
      if (isUnique(root, selector)) return selector;
    }
  }
  const segments: string[] = [];
  let current: Element | null = element;
  while (current) {
    if (current.id && isUnique(root, `#${CSS.escape(current.id)}`)) {
      segments.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    segments.unshift(segmentFor(current));
    const selector = segments.join(" > ");
    if (isUnique(root, selector)) return selector;
    current = current.parentElement;
  }
  return segments.join(" > ");
}

/** Selector that crosses open shadow roots with `>>>`, outermost host first. */
export function uniqueSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    parts.unshift(selectorInRoot(current));
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return clip(parts.join(SHADOW_SEPARATOR), LIMITS.selector);
}

/** Resolves a selector made by uniqueSelector. */
export function querySelectorDeep(selector: string, root: Document = document): Element | null {
  const parts = selector.split(SHADOW_SEPARATOR);
  let scope: Document | ShadowRoot | null = root;
  let found: Element | null = null;
  for (const part of parts) {
    if (!scope) return null;
    try {
      found = scope.querySelector(part);
    } catch {
      return null;
    }
    scope = found?.shadowRoot ?? null;
  }
  return found;
}

function pathLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (element.id) return `${tag}#${element.id}`;
  const testId = element.getAttribute("data-testid");
  if (testId) return `${tag}[data-testid=${testId}]`;
  const classes = meaningfulClasses(element).slice(0, 1);
  return `${tag}${classes.map((item) => `.${item}`).join("")}`;
}

/** Up to four ancestors with ids, test ids or meaningful classes; shadow boundaries are marked. */
export function elementPath(element: Element): string {
  const labels: string[] = [pathLabel(element)];
  let current: Element = element;
  let ancestors = 0;
  while (ancestors < MAX_PATH_ANCESTORS) {
    let parent: Element | null = current.parentElement;
    let crossed = false;
    if (!parent) {
      const root = current.getRootNode();
      if (root instanceof ShadowRoot) {
        parent = root.host;
        crossed = true;
      }
    }
    if (!parent || parent === document.documentElement || parent === document.body) break;
    const informative = parent.id || parent.getAttribute("data-testid") || meaningfulClasses(parent).length > 0 || crossed;
    if (informative) {
      labels.unshift(`${pathLabel(parent)}${crossed ? " ⟨shadow⟩" : ""}`);
      ancestors += 1;
    }
    current = parent;
  }
  return clip(labels.join(" > "), LIMITS.elementPath);
}

function stylesFor(element: Element): string[] {
  const keys = [...BASE_STYLES];
  if (TEXT_TAGS.has(element.tagName) || textOf(element).length > 0) keys.push(...TEXT_STYLES);
  if (FORM_TAGS.has(element.tagName)) keys.push(...FORM_STYLES);
  const display = getComputedStyle(element).display;
  if (display.includes("flex") || display.includes("grid")) keys.push(...LAYOUT_STYLES);
  return [...new Set(keys)];
}

export function computedStyles(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  const result: Record<string, string> = {};
  for (const key of stylesFor(element).slice(0, LIMITS.styleEntries)) {
    const value = style.getPropertyValue(key);
    if (value) result[key] = clip(value, LIMITS.styleValue);
  }
  return result;
}

export function nearbyText(element: Element): string | null {
  const own = textOf(element);
  if (own) return clip(own, LIMITS.nearbyText);
  const parent = element.parentElement;
  const around = parent ? textOf(parent) : "";
  return around ? clip(around, LIMITS.nearbyText) : null;
}

/** Bounding box in document coordinates, so it survives scrolling. */
export function documentRect(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
}

export function buildDomContext(element: Element): DomContext {
  return {
    element: describeElement(element),
    selector: uniqueSelector(element),
    elementPath: elementPath(element),
    nearbyText: nearbyText(element),
    computedStyles: computedStyles(element),
    accessibility: describeAccessibility(element),
    boundingBox: documentRect(element),
  };
}

export function isTextLike(element: Element): boolean {
  if (TEXT_TAGS.has(element.tagName)) return true;
  return [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && squash(node.textContent).length > 0);
}
