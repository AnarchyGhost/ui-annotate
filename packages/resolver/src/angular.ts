import type { Frame } from "./types.js";

/**
 * Angular 17+ dev mode exposes `window.ng` debug utilities, and the compiler sets
 * `ɵcmp.debugInfo = { className, filePath, lineNumber }` on every component class
 * (`ɵsetClassDebugInfo`). The line points at the class declaration, not the template.
 */
interface NgGlobal {
  getOwningComponent?: (element: Element) => object | null;
  getComponent?: (element: Element) => object | null;
  getHostElement?: (component: object) => Element | null;
}

interface ClassDebugInfo {
  className?: unknown;
  filePath?: unknown;
  lineNumber?: unknown;
}

const MAX_DEPTH = 8;

function readNg(): NgGlobal | null {
  const ng: unknown = Reflect.get(window, "ng");
  return typeof ng === "object" && ng !== null ? (ng as NgGlobal) : null;
}

function frameOf(component: object): Frame | null {
  const ctor: unknown = component.constructor;
  if (typeof ctor !== "function") return null;
  const def: unknown = Reflect.get(ctor, "ɵcmp");
  if (typeof def !== "object" || def === null) return null;
  const info = Reflect.get(def, "debugInfo") as ClassDebugInfo | undefined;
  const name = typeof info?.className === "string" ? info.className : ctor.name || null;
  if (!info || typeof info.filePath !== "string") {
    return name ? { file: "", line: null, column: null, componentName: name } : null;
  }
  return {
    file: info.filePath,
    line: typeof info.lineNumber === "number" && info.lineNumber > 0 ? info.lineNumber : null,
    column: null,
    componentName: name,
  };
}

export function isAngularDevMode(): boolean {
  return typeof readNg()?.getOwningComponent === "function";
}

export function isAngularPage(): boolean {
  return document.querySelector("[ng-version]") !== null;
}

/** Owning component of the element, then the components that host it, innermost first. */
export function resolveAngularStack(element: Element): Frame[] {
  const ng = readNg();
  if (!ng?.getOwningComponent) return [];
  const frames: Frame[] = [];
  let component = ng.getComponent?.(element) ?? ng.getOwningComponent(element);
  for (let depth = 0; component && depth < MAX_DEPTH; depth += 1) {
    const frame = frameOf(component);
    if (frame) frames.push(frame);
    const host = ng.getHostElement?.(component);
    if (!host) break;
    component = ng.getOwningComponent(host);
  }
  return frames;
}
