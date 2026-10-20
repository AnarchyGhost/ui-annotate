import type { Annotation, Rect } from "@ui-annotate/protocol";
import { querySelectorDeep } from "./dom-context";

export interface Placement {
  /** Document coordinates of the annotated region. */
  rect: Rect;
  /** False when the element was not found and the stored box is used. */
  attached: boolean;
}

/** Same element if the live box is within a factor of two of the stored one in both dimensions. */
function similarSize(live: DOMRect, stored: Rect): boolean {
  if (stored.width === 0 || stored.height === 0) return true;
  const ratio = (a: number, b: number) => (a === 0 || b === 0 ? 0 : Math.min(a, b) / Math.max(a, b));
  return ratio(live.width, stored.width) >= 0.5 && ratio(live.height, stored.height) >= 0.5;
}

/**
 * The marker follows its element: re-find it by selector and check the size against the stored
 * box, so a selector that now matches a different element does not move the marker. The stored
 * coordinates are the fallback.
 */
export function placeAnnotation(annotation: Annotation): Placement {
  if (annotation.kind === "area" && annotation.area) return { rect: annotation.area, attached: false };
  const target = annotation.targets[0];
  if (!target) return { rect: { x: 0, y: 0, width: 0, height: 0 }, attached: false };
  const element = querySelectorDeep(target.selector);
  if (element) {
    const live = element.getBoundingClientRect();
    if (live.width + live.height > 0 && similarSize(live, target.boundingBox)) {
      return { rect: { x: live.left + window.scrollX, y: live.top + window.scrollY, width: live.width, height: live.height }, attached: true };
    }
  }
  return { rect: target.boundingBox, attached: false };
}
