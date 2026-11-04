import type { FeatureCollection } from 'geojson';
import type { MapCoordinate } from '../types';

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

/** The narrowest free map width beside the compact layout's left column that still takes the map notices. */
export const COMPACT_NOTICE_MIN_PX = 280;

/** Map height the compact layout's top inset always leaves below it: one notice above the map buttons. */
export const COMPACT_TOP_KEEP_PX = 120;

/**
 * Insets in the compact touch layout (lib/compactLayout.ts), where Lapisan and
 * the estimate card float over the main view's top-left corner. With at least
 * COMPACT_NOTICE_MIN_PX of map free beside them (a tablet) only `left` is
 * set, so the notices sit top-centre in the free part and the camera frames
 * there; on a map narrower than that (a phone) only `top`, the lowest panel
 * bottom plus `gap`, leaving at least COMPACT_TOP_KEEP_PX of the map below,
 * so the notices go full width under the panels (noticePlacement()) instead
 * of under the panel itself. A right column (none in the compact stage since
 * 3.14.0) always counts as `top`.
 */
export function compactMapInsets(
  map: RectLike,
  panels: { left?: readonly RectLike[]; right?: readonly RectLike[] },
  gap = 8,
): MapInsets {
  const left = (panels.left ?? []).filter((rect) => overlaps(rect, map));
  const right = (panels.right ?? []).filter((rect) => overlaps(rect, map));
  if (left.length === 0 && right.length === 0) return { ...ZERO_INSETS };
  const edge = Math.max(...left.map((rect) => rect.right), map.left);
  if (right.length === 0 && map.right - edge - 2 * gap >= COMPACT_NOTICE_MIN_PX) {
    return { top: 0, right: 0, bottom: 0, left: whole(edge - map.left + gap) };
  }
  const lowest = Math.max(...[...left, ...right].map((rect) => rect.bottom));
  const height = Number.isFinite(map.bottom - map.top) ? Math.max(0, map.bottom - map.top) : 0;
  return { top: whole(Math.min(lowest - map.top + gap, height - COMPACT_TOP_KEEP_PX)), right: 0, bottom: 0, left: 0 };
}

/**
 * Where the compact layout's right column (node card, Kontrol) starts, in px
 * from the map's top, when a map too narrow for both columns side by side
 * (a phone: 240 + 320 px and the gaps) would let it cover the HUD: just under
 * the left column. `null` while they fit beside each other or a column is empty.
 */
export function stackedRightTop(map: RectLike, left: RectLike | null, right: RectLike | null, gap = 8): number | null {
  if (!left || !right || left.right - left.left <= 0 || right.right - right.left <= 0) return null;
  if (right.left >= left.right) return null;
  return whole(left.bottom - map.top + gap);
}

/**
 * The insets the camera frames with: all of them on the PC; in the compact
 * layout the top and left ones compactMapInsets() sets (never the right or
 * bottom: the side panel and the info row are beside the map, not over it).
 */
export function cameraInsets(insets: MapInsets, compact: boolean): MapInsets {
  return compact ? { top: insets.top, right: 0, bottom: 0, left: insets.left } : insets;
}

/**
 * Where the map notices go, as overrides of their stylesheet position (top and
 * sides at the map gap). On the PC they sit top-centre between the side
 * panels; in the compact layout beside the left panel where the map has room
 * (a tablet), else across the map's width under it (a phone), so the panel
 * never covers them. `undefined` keeps the stylesheet position.
 */
export function noticePlacement(insets: MapInsets, compact: boolean, gap = 12): { top?: number; left?: number; right?: number } | undefined {
  if (compact) {
    if (insets.left > 0) return { left: whole(insets.left) };
    return insets.top > 0 ? { top: whole(insets.top) } : undefined;
  }
  return insets.left || insets.right ? { left: whole(insets.left) + gap, right: whole(insets.right) + gap } : undefined;
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

/**
 * Camera bounds around the station and every drawn part of the DoA graph, so the
 * graph and its direction fill a small map; null while nothing of it is drawn.
 */
export function graphBounds(collections: ReadonlyArray<FeatureCollection>, station: MapCoordinate): [[number, number], [number, number]] | null {
  let west = station.longitude;
  let east = station.longitude;
  let south = station.latitude;
  let north = station.latitude;
  let drawn = false;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      const [lon, lat] = value as number[];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      drawn = true;
      west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat);
      return;
    }
    for (const item of value) visit(item);
  };
  for (const collection of collections) {
    for (const feature of collection.features) {
      const geometry = feature.geometry as { coordinates?: unknown } | null;
      if (geometry && 'coordinates' in geometry) visit(geometry.coordinates);
    }
  }
  return drawn ? [[west, south], [east, north]] : null;
}
