import type { Framework } from "./types.js";
import { isAngularDevMode, isAngularPage } from "./angular.js";

const hasKeyPrefix = (element: Element, prefix: string): boolean =>
  Object.keys(element).some((key) => key.startsWith(prefix));

/**
 * Framework present on the page while its dev-only internals are missing: a production build.
 * Used only to explain an empty source in `reason`.
 */
export function detectProductionFramework(element: Element): Framework | null {
  let current: Element | null = element;
  while (current) {
    if (hasKeyPrefix(current, "__reactFiber$") || hasKeyPrefix(current, "__reactContainer$")) return "react";
    if (Reflect.get(current, "__vue_app__") || Reflect.get(current, "__vnode")) return "vue";
    current = current.parentElement;
  }
  if (isAngularPage() && !isAngularDevMode()) return "angular";
  return null;
}
