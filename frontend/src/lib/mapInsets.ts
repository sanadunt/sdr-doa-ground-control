/**
 * Space the floating Overview panels take from the map, in CSS pixels. The map
 * keeps drawing under the panels; the insets only move the camera's framing
 * area (MapLibre padding) so the station and its overlay stay in the free part.
 */
export interface MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_INSETS: Readonly<MapInsets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlaps(a: RectLike, b: RectLike): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom && a.right > a.left && a.bottom > a.top;
}

function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Insets from the panels that float over the map. Panels that do not overlap
 * the map (the stacked narrow layout puts them below it) add nothing.
 */
export function computeMapInsets(
  map: RectLike,
  panels: { left?: readonly RectLike[]; right?: readonly RectLike[]; bottom?: readonly RectLike[] },
  gap = 12,
): MapInsets {
  let left = 0;
  let right = 0;
  let bottom = 0;
  for (const rect of panels.left ?? []) if (overlaps(rect, map)) left = Math.max(left, rect.right - map.left + gap);
  for (const rect of panels.right ?? []) if (overlaps(rect, map)) right = Math.max(right, map.right - rect.left + gap);
  for (const rect of panels.bottom ?? []) if (overlaps(rect, map)) bottom = Math.max(bottom, map.bottom - rect.top);
  return { top: 0, right: whole(right), bottom: whole(bottom), left: whole(left) };
}

/** One row of the bottom-left map buttons. */
export const MAP_CONTROLS_ROW_PX = 44;

/**
 * Bottom framing padding that keeps the overlay clear of the bottom-left map
 * controls: their measured height plus their 12 px margin and 12 px of
 * clearance. At phone width the row wraps (the attribution moves to a second
 * line), so a fixed one-row value would put the south guide under the buttons.
 */
export function controlsFramingBottom(controlsHeight: number, clearance = 24): number {
  const height = Number.isFinite(controlsHeight) && controlsHeight > MAP_CONTROLS_ROW_PX ? controlsHeight : MAP_CONTROLS_ROW_PX;
  return Math.round(height + clearance);
}

export function sameInsets(a: MapInsets, b: MapInsets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * Map padding that still leaves fitBounds room to work. MapLibre adds the map
 * padding to the fitBounds padding and silently skips the camera move when the
 * two leave no space, so each axis is scaled down until both together use at
 * most `share` of the canvas.
 */
export function clampMapPadding(insets: MapInsets, width: number, height: number, framing: MapInsets, share = 0.8): MapInsets {
  const axis = (start: number, end: number, size: number, frameStart: number, frameEnd: number): [number, number] => {
    const a = whole(start);
    const b = whole(end);
    const budget = Math.max(0, (Number.isFinite(size) ? size : 0) * share - whole(frameStart) - whole(frameEnd));
    if (a + b <= budget) return [a, b];
    if (a + b === 0) return [0, 0];
    const scale = budget / (a + b);
    return [Math.floor(a * scale), Math.floor(b * scale)];
  };
  const [left, right] = axis(insets.left, insets.right, width, framing.left, framing.right);
  const [top, bottom] = axis(insets.top, insets.bottom, height, framing.top, framing.bottom);
  return { top, right, bottom, left };
}
