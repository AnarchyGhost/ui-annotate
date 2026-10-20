import { getDisplayName, getFiberFromHostInstance, isCompositeFiber } from "bippy";
import { isSourceFile, parseStack } from "bippy/source";
import { mapPosition, mapSourceObject, moduleUrlForFile } from "./sourcemap.js";
import type { Frame } from "./types.js";

/**
 * React adapter on bippy primitives. Each fiber knows where its element was created:
 * React 18 keeps `_debugSource` from jsxDEV, React 19 keeps `_debugStack` (an Error captured at
 * the jsxDEV call) whose first user-code frame, mapped through the module source map, is the JSX line.
 * `_debugSource` is mapped too: with @vitejs/plugin-react 4 a Babel pass prepends the refresh
 * preamble before the JSX transform, so its lineNumber is shifted by the preamble length.
 * The owner chain (`_debugOwner`) gives the component and its parents.
 */
interface DebugSource {
  fileName?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
}

interface LooseFiber {
  type: unknown;
  return: LooseFiber | null;
  _debugOwner?: LooseFiber | null;
  _debugSource?: DebugSource | null;
  _debugStack?: { stack?: unknown } | null;
}

const MAX_OWNERS = 8;
const symbolicated = new WeakMap<object, Promise<Frame | null>>();

function hostFiberOf(element: Element): LooseFiber | null {
  let current: Element | null = element;
  while (current) {
    const fiber = getFiberFromHostInstance(current) as LooseFiber | null;
    if (fiber) return fiber;
    current = current.parentElement;
  }
  return null;
}

async function fromDebugSource(source: DebugSource): Promise<Frame | null> {
  if (typeof source.fileName !== "string") return null;
  const line = typeof source.lineNumber === "number" ? source.lineNumber : null;
  const column = typeof source.columnNumber === "number" ? source.columnNumber : null;
  const url = line === null ? null : moduleUrlForFile(source.fileName);
  const mapped = url && line !== null ? await mapSourceObject(url, line, column) : null;
  return {
    file: source.fileName,
    line: mapped?.line ?? line,
    column: mapped ? mapped.column : column,
    componentName: null,
  };
}

async function fromDebugStack(stack: unknown): Promise<Frame | null> {
  if (typeof stack !== "string") return null;
  const first = parseStack(stack).find((frame) => frame.fileName && isSourceFile(frame.fileName));
  if (!first?.fileName || first.lineNumber === undefined) return null;
  const mapped = await mapPosition(first.fileName, first.lineNumber, first.columnNumber ?? 1);
  if (mapped) return { file: mapped.file, line: mapped.line, column: mapped.column, componentName: null };
  return { file: first.fileName, line: first.lineNumber, column: first.columnNumber ?? null, componentName: null };
}

/** Where the element of this fiber was created in source; cached per debug object. */
function creationSite(fiber: LooseFiber): Promise<Frame | null> {
  const key = fiber._debugSource ?? fiber._debugStack;
  if (!key) return Promise.resolve(null);
  let pending = symbolicated.get(key);
  if (!pending) {
    pending = (fiber._debugSource ? fromDebugSource(fiber._debugSource) : fromDebugStack(fiber._debugStack?.stack)).catch(
      () => null,
    );
    symbolicated.set(key, pending);
  }
  return pending;
}

function nameOf(fiber: LooseFiber): string | null {
  const name = getDisplayName(fiber.type as Parameters<typeof getDisplayName>[0]);
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Owner of a host fiber; falls back to the nearest composite ancestor when React omits owners. */
function ownerOf(fiber: LooseFiber): LooseFiber | null {
  if (fiber._debugOwner) return fiber._debugOwner;
  let current = fiber.return;
  while (current) {
    if (isCompositeFiber(current as Parameters<typeof isCompositeFiber>[0])) return current;
    current = current.return;
  }
  return null;
}

export interface ReactResult {
  frames: Frame[];
  componentName: string | null;
}

/**
 * First frame: the element's own JSX line, attributed to the component that rendered it.
 * Following frames: where each owner component was itself used by its parent.
 */
export async function resolveReact(element: Element): Promise<ReactResult | null> {
  const host = hostFiberOf(element);
  if (!host) return null;
  const owner = ownerOf(host);
  const componentName = owner ? nameOf(owner) : null;
  const frames: Frame[] = [];

  const own = await creationSite(host);
  if (own) frames.push({ ...own, componentName });

  let current = owner;
  for (let depth = 0; current && depth < MAX_OWNERS; depth += 1) {
    const parent = ownerOf(current);
    const site = await creationSite(current);
    if (site) frames.push({ ...site, componentName: parent ? nameOf(parent) : null });
    current = parent;
  }
  return { frames, componentName };
}
