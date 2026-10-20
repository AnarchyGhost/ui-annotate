const PANEL_WIDTH = 340;
const GAP = 12;
const EDGE = 12;

/** Fixed position for a floating panel next to a viewport point, kept inside the viewport. */
export function panelPosition(anchor: { x: number; y: number }, height = 260): { left: string; top: string } {
  let left = anchor.x + GAP;
  if (left + PANEL_WIDTH > window.innerWidth - EDGE) left = anchor.x - PANEL_WIDTH - GAP;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - PANEL_WIDTH - EDGE));
  let top = anchor.y + GAP;
  if (top + height > window.innerHeight - EDGE) top = window.innerHeight - height - EDGE;
  top = Math.max(EDGE, top);
  return { left: `${left}px`, top: `${top}px` };
}
