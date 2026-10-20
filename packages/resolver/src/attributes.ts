import type { AttributeLocation } from "./types.js";

/**
 * Attributes written by third-party build plugins. They point at the template line,
 * which framework runtimes do not expose for Vue, Angular templates and Solid.
 *
 * - `data-insp-path` (code-inspector-plugin): `path:line:column:tag`; may also be an element property.
 * - `data-v-inspector` (vite-plugin-vue-inspector): `relativePath:line:column`.
 * - `data-locatorjs` (@locator/babel-jsx, path mode): `projectPath+filePath:line:column0`.
 * - `data-source-loc` (solid-devtools locator): `path:line:column`.
 */
interface AttributeSpec {
  name: string;
  /** Number of trailing `:`-separated parts after line and column (code-inspector appends the tag). */
  trailing: number;
  zeroBasedColumn: boolean;
  readProperty: boolean;
}

const SPECS: AttributeSpec[] = [
  { name: "data-insp-path", trailing: 1, zeroBasedColumn: false, readProperty: true },
  { name: "data-v-inspector", trailing: 0, zeroBasedColumn: false, readProperty: false },
  { name: "data-locatorjs", trailing: 0, zeroBasedColumn: true, readProperty: false },
  { name: "data-source-loc", trailing: 0, zeroBasedColumn: false, readProperty: false },
];

const toPositive = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
};

export function parseAttributeValue(spec: AttributeSpec, value: string): AttributeLocation | null {
  const parts = value.split(":");
  const lineIndex = parts.length - spec.trailing - 2;
  if (lineIndex < 1) return null;
  const line = toPositive(parts[lineIndex]);
  const column = toPositive(parts[lineIndex + 1]);
  const file = parts.slice(0, lineIndex).join(":");
  if (!file || line === null || line < 1) return null;
  return {
    attribute: spec.name,
    file,
    line,
    column: column === null ? null : spec.zeroBasedColumn ? column + 1 : column,
  };
}

function readOwn(element: Element, spec: AttributeSpec): string | null {
  const attribute = element.getAttribute(spec.name);
  if (attribute) return attribute;
  if (!spec.readProperty) return null;
  const property: unknown = Reflect.get(element, spec.name);
  return typeof property === "string" && property.length > 0 ? property : null;
}

const VUE_INSPECTOR_SPEC = SPECS[1]!;

/**
 * vite-plugin-vue-inspector ≥7 strips `data-v-inspector` from the DOM: the value moves to a
 * hidden `__v_inspector` prop of the vnode and to `globalThis.__vue_inspector_store__.vnodeToPos`.
 * Vue dev builds expose the vnode as `el.__vnode`.
 */
function readVueInspectorVNode(element: Element): string | null {
  const vnode: unknown = Reflect.get(element, "__vnode");
  if (typeof vnode !== "object" || vnode === null) return null;
  const props: unknown = Reflect.get(vnode, "props");
  if (typeof props !== "object" || props === null) return null;
  const hidden: unknown = Reflect.get(props, "__v_inspector");
  if (typeof hidden === "string") return hidden;
  const store: unknown = Reflect.get(globalThis, "__vue_inspector_store__");
  const positions: unknown = typeof store === "object" && store !== null ? Reflect.get(store, "vnodeToPos") : null;
  if (!(positions instanceof WeakMap)) return null;
  const position: unknown = positions.get(props);
  if (!Array.isArray(position) || position.length < 3) return null;
  return `${String(position[0])}:${String(position[1])}:${String(position[2])}`;
}

/** Nearest element (self first, then ancestors) carrying any known attribute wins. */
export function readAttributeLocation(element: Element): AttributeLocation | null {
  let current: Element | null = element;
  while (current) {
    for (const spec of SPECS) {
      const value = readOwn(current, spec);
      if (!value) continue;
      const parsed = parseAttributeValue(spec, value);
      if (parsed) return parsed;
    }
    const vnodeValue = readVueInspectorVNode(current);
    const parsed = vnodeValue ? parseAttributeValue(VUE_INSPECTOR_SPEC, vnodeValue) : null;
    if (parsed) return parsed;
    current = current.parentElement;
  }
  return null;
}

export const ATTRIBUTE_NAMES = SPECS.map((spec) => spec.name);
