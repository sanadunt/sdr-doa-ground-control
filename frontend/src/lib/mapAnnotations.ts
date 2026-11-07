import { useCallback, useEffect, useRef, useState } from 'react';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { bearingAndDistance } from './doaGeometry';
import { gsRelativeXY } from './gridCoordinates';
import type { MessageKey } from './i18n';

/**
 * The operators' map annotations (tools/map_annotations.py, owner's decisions
 * of 2026-11-06 and 2026-11-07): areas (geofences) and point markers with a
 * name, a note, a category and a colour, kept on the console host and shared
 * by the groundstation page and every LAN view tablet. Anyone may add,
 * change or remove one; a change carries the item's rev, so a change made on
 * another page in between is a conflict, never a silent overwrite.
 */
export const MAP_ANNOTATIONS_ROUTE = '/api/map/annotations';

/** The server's numbers (tools/test_map_annotations.py compares them). */
export const MAP_ANNOTATION_LIMITS = {
  maxItems: 500,
  maxBodyBytes: 16384,
  nameMax: 64,
  noteMax: 500,
  areaMinVertices: 3,
  areaMaxVertices: 200,
  writesPerS: 5,
} as const;

export type AnnotationKind = 'point' | 'area';
export type AnnotationCategory = 'suspect' | 'nogo' | 'safe' | 'info';
export const ANNOTATION_CATEGORIES: readonly AnnotationCategory[] = ['suspect', 'nogo', 'safe', 'info'];
/** The palette the pages offer, in the server's order. */
export const MAP_ANNOTATION_COLORS = ['#f08a24', '#e5484d', '#30a46c', '#3e8ed0', '#a78bfa', '#f5d90a', '#14b8a6', '#ffffff'] as const;
export type AnnotationColor = typeof MAP_ANNOTATION_COLORS[number];
/** Each category's own colour, the default when it is picked. */
export const CATEGORY_COLORS: Record<AnnotationCategory, AnnotationColor> = {
  suspect: '#f08a24',
  nogo: '#e5484d',
  safe: '#30a46c',
  info: '#3e8ed0',
};

export type LonLat = [number, number];

export interface MapAnnotation {
  id: string;
  kind: AnnotationKind;
  category: AnnotationCategory;
  color: AnnotationColor;
  name: string;
  note: string;
  /** A point's [lon, lat], or an area's corners (open ring). */
  geometry: LonLat | LonLat[];
  rev: number;
  createdMs: number;
  updatedMs: number;
  /** "groundstation" or "tablet <address>". */
  by: string;
}

/** What a page draws and fills in before saving. */
export interface AnnotationDraft {
  kind: AnnotationKind;
  category: AnnotationCategory;
  color: AnnotationColor;
  name: string;
  note: string;
  geometry: LonLat | LonLat[];
}

/** The codes the route answers with, and the page's own. */
export const ANNOTATION_ERROR_CODES = [
  'ORIGIN_REJECTED',
  'ANNOTATION_INVALID',
  'ANNOTATION_TOO_LARGE',
  'ANNOTATION_RATE_LIMITED',
  'ANNOTATION_NOT_FOUND',
  'ANNOTATION_CONFLICT',
  'ANNOTATION_LIMIT',
  'ANNOTATION_STORE_FAILED',
  'MIRROR_LAN_CLOSED',
  'NETWORK',
  'TIMEOUT',
] as const;
export type AnnotationErrorCode = typeof ANNOTATION_ERROR_CODES[number];

export function annotationErrorKey(code: string): MessageKey {
  const known = (ANNOTATION_ERROR_CODES as readonly string[]).includes(code) ? code : 'ANNOTATION_INVALID';
  return `annot.error.${known}` as MessageKey;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function lonLat(value: unknown): LonLat | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lon, lat] = value as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

function wholeNumber(value: unknown, low = 0): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= low ? value : null;
}

/** One stored annotation, or null when the server's item is not one this page can draw. */
export function normalizeAnnotation(value: unknown): MapAnnotation | null {
  const item = record(value);
  if (!item) return null;
  const { id, kind, category, color, name, note, by } = item;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/u.test(id)) return null;
  if (kind !== 'point' && kind !== 'area') return null;
  if (!ANNOTATION_CATEGORIES.includes(category as AnnotationCategory)) return null;
  if (!(MAP_ANNOTATION_COLORS as readonly string[]).includes(color as string)) return null;
  if (typeof name !== 'string' || typeof note !== 'string') return null;
  const rev = wholeNumber(item.rev, 1);
  const createdMs = wholeNumber(item.created_ms);
  const updatedMs = wholeNumber(item.updated_ms);
  if (rev === null || createdMs === null || updatedMs === null) return null;
  let geometry: LonLat | LonLat[] | null;
  if (kind === 'point') {
    geometry = lonLat(item.geometry);
  } else {
    const corners = Array.isArray(item.geometry) ? item.geometry.map(lonLat) : [];
    geometry = corners.length >= MAP_ANNOTATION_LIMITS.areaMinVertices && corners.every((corner) => corner !== null) ? corners as LonLat[] : null;
  }
  if (!geometry) return null;
  return {
    id, kind, category: category as AnnotationCategory, color: color as AnnotationColor,
    name: name.slice(0, MAP_ANNOTATION_LIMITS.nameMax), note: note.slice(0, MAP_ANNOTATION_LIMITS.noteMax),
    geometry, rev, createdMs, updatedMs, by: typeof by === 'string' ? by.slice(0, 80) : '',
  };
}

export type AnnotationsAnswer = { rev: number; unchanged: true } | { rev: number; unchanged: false; items: MapAnnotation[] };

/** GET's answer: unchanged since the page's rev, or every annotation it can draw. Null for anything else. */
export function normalizeAnnotationsAnswer(value: unknown): AnnotationsAnswer | null {
  const body = record(value);
  const rev = body ? wholeNumber(body.rev) : null;
  if (!body || body.ok !== true || rev === null) return null;
  if (body.unchanged === true) return { rev, unchanged: true };
  if (!Array.isArray(body.items)) return null;
  const items = body.items.slice(0, MAP_ANNOTATION_LIMITS.maxItems).map(normalizeAnnotation).filter((item): item is MapAnnotation => item !== null);
  return { rev, unchanged: false, items };
}

export type AnnotationWrite =
  | { op: 'create'; item: AnnotationDraft }
  | { op: 'update'; id: string; rev: number; item: AnnotationDraft }
  | { op: 'delete'; id: string; rev: number };

export type AnnotationWriteResult =
  | { ok: true; item: MapAnnotation | null; rev: number }
  | { ok: false; code: AnnotationErrorCode; current: MapAnnotation | null };

const WRITE_TIMEOUT_MS = 8000;
const READ_TIMEOUT_MS = 6000;
export const ANNOTATIONS_POLL_MS = 2000;

function requestBody(write: AnnotationWrite): string {
  const item = 'item' in write ? {
    kind: write.item.kind, category: write.item.category, color: write.item.color,
    name: write.item.name.trim(), note: write.item.note.trim(), geometry: write.item.geometry,
  } : undefined;
  if (write.op === 'create') return JSON.stringify({ v: 1, op: 'create', item });
  if (write.op === 'update') return JSON.stringify({ v: 1, op: 'update', id: write.id, rev: write.rev, item });
  return JSON.stringify({ v: 1, op: 'delete', id: write.id, rev: write.rev });
}

/** POST one change; never throws. */
export async function writeAnnotation(write: AnnotationWrite, fetcher: typeof fetch = fetch): Promise<AnnotationWriteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  try {
    const response = await fetcher(MAP_ANNOTATIONS_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(write),
      signal: controller.signal,
      credentials: 'same-origin',
    });
    const body = record(await response.json().catch(() => null));
    if (response.ok && body?.ok === true) {
      const rev = wholeNumber(body.rev) ?? 0;
      return { ok: true, item: body.item === null ? null : normalizeAnnotation(body.item), rev };
    }
    const code = typeof body?.code === 'string' && (ANNOTATION_ERROR_CODES as readonly string[]).includes(body.code) ? body.code as AnnotationErrorCode : 'ANNOTATION_INVALID';
    return { ok: false, code, current: normalizeAnnotation(body?.item) };
  } catch (error) {
    return { ok: false, code: error instanceof DOMException && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', current: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface MapAnnotationsState {
  items: MapAnnotation[];
  /** The last read failed (the set shown may be old). */
  stale: boolean;
  /** Read again now (after a write). */
  refresh: () => void;
}

/**
 * Every annotation, read every ANNOTATIONS_POLL_MS while `enabled` and the
 * page is visible, with `since`, so an unchanged set costs a few bytes.
 */
export function useMapAnnotations(enabled: boolean, fetcher: typeof fetch = fetch): MapAnnotationsState {
  const [items, setItems] = useState<MapAnnotation[]>([]);
  const [stale, setStale] = useState(false);
  const revRef = useRef<number | null>(null);
  const kickRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = 0;
    let controller: AbortController | null = null;
    const read = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(read, ANNOTATIONS_POLL_MS);
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const abort = window.setTimeout(() => controller?.abort(), READ_TIMEOUT_MS);
      try {
        const since = revRef.current === null ? '' : `?since=${revRef.current}`;
        const response = await fetcher(`${MAP_ANNOTATIONS_ROUTE}${since}`, { signal: controller.signal, credentials: 'same-origin' });
        const answer = normalizeAnnotationsAnswer(await response.json());
        if (cancelled) return;
        if (!response.ok || !answer) throw new Error('bad answer');
        if (!answer.unchanged) setItems(answer.items);
        revRef.current = answer.rev;
        setStale(false);
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        window.clearTimeout(abort);
        if (!cancelled) timer = window.setTimeout(read, ANNOTATIONS_POLL_MS);
      }
    };
    kickRef.current = () => { void read(); };
    void read();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller?.abort();
      kickRef.current = () => undefined;
    };
  }, [enabled, fetcher]);
  const refresh = useCallback(() => kickRef.current(), []);
  return { items, stale, refresh };
}

// -- measuring ---------------------------------------------------------------

/** The length of a path, metres (great circle per leg). */
export function pathLengthM(points: readonly LonLat[]): number {
  let total = 0;
  for (let k = 1; k < points.length; k += 1) {
    total += bearingAndDistance({ longitude: points[k - 1][0], latitude: points[k - 1][1] }, points[k][0], points[k][1]).distanceM;
  }
  return total;
}

/** The bearing of a path's last leg, degrees from north, or null with fewer than two points. */
export function lastLegBearing(points: readonly LonLat[]): number | null {
  if (points.length < 2) return null;
  const [from, to] = [points[points.length - 2], points[points.length - 1]];
  return bearingAndDistance({ longitude: from[0], latitude: from[1] }, to[0], to[1]).bearingDeg;
}

/** An area's size, square metres, on the ellipsoid's local plane around its first corner. */
export function polygonAreaM2(corners: readonly LonLat[]): number {
  if (corners.length < 3) return 0;
  const origin = { longitude: corners[0][0], latitude: corners[0][1] };
  const plane = corners.map(([longitude, latitude]) => gsRelativeXY(origin, { longitude, latitude }));
  let twice = 0;
  for (let k = 0; k < plane.length; k += 1) {
    const a = plane[k];
    const b = plane[(k + 1) % plane.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** An area's perimeter, metres (the ring closed). */
export function polygonPerimeterM(corners: readonly LonLat[]): number {
  return corners.length < 2 ? 0 : pathLengthM([...corners, corners[0]]);
}

/** Whether a point lies inside an area (ray casting on longitude/latitude, fine for areas of a few kilometres). */
export function pointInPolygon(point: LonLat, corners: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i, i += 1) {
    const [xi, yi] = corners[i];
    const [xj, yj] = corners[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** "850 m", "1.2 km", "12 km". */
export function formatLength(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 2)} km`;
}

/** "850 m²", "4.3 ha", "3.40 km²". */
export function formatArea(squareMetres: number): string {
  if (squareMetres < 10_000) return `${Math.round(squareMetres)} m²`;
  if (squareMetres < 1_000_000) return `${(squareMetres / 10_000).toFixed(1)} ha`;
  return `${(squareMetres / 1_000_000).toFixed(2)} km²`;
}

/** The no-go areas a position is inside of (the geofence warning). */
export function geofenceHits(position: LonLat | null, items: readonly MapAnnotation[]): MapAnnotation[] {
  if (!position) return [];
  return items.filter((item) => item.kind === 'area' && item.category === 'nogo' && pointInPolygon(position, item.geometry as LonLat[]));
}

/** Where an annotation sits for the camera: the point, or its corners' middle. */
export function annotationCentre(item: Pick<MapAnnotation, 'kind' | 'geometry'>): LonLat {
  if (item.kind === 'point') return item.geometry as LonLat;
  const corners = item.geometry as LonLat[];
  const lon = corners.reduce((sum, corner) => sum + corner[0], 0) / corners.length;
  const lat = corners.reduce((sum, corner) => sum + corner[1], 0) / corners.length;
  return [lon, lat];
}

// -- map geometry ------------------------------------------------------------

export interface AnnotationFeatureProperties {
  id: string;
  kind: AnnotationKind;
  color: string;
  name: string;
  selected: boolean;
  /** A no-go area the drone is inside of. */
  alert: boolean;
}

/** Areas (closed rings) and points for the map's annotation layers. */
export function annotationFeatures(items: readonly MapAnnotation[], selectedId: string | null, alertIds: ReadonlySet<string>): FeatureCollection<Geometry, AnnotationFeatureProperties> {
  return {
    type: 'FeatureCollection',
    features: items.map((item): Feature<Geometry, AnnotationFeatureProperties> => ({
      type: 'Feature',
      properties: { id: item.id, kind: item.kind, color: item.color, name: item.name, selected: item.id === selectedId, alert: alertIds.has(item.id) },
      geometry: item.kind === 'point'
        ? { type: 'Point', coordinates: item.geometry as LonLat }
        : { type: 'Polygon', coordinates: [[...(item.geometry as LonLat[]), (item.geometry as LonLat[])[0]]] },
    })),
  };
}

export type AnnotationTool = 'none' | 'measure' | 'area' | 'point' | 'list';

/** The shape being drawn: its line (closed for an area once it has three corners) and its corners. */
export function draftFeatures(tool: AnnotationTool, points: readonly LonLat[]): FeatureCollection<Geometry, { role: 'line' | 'corner' }> {
  const features: Array<Feature<Geometry, { role: 'line' | 'corner' }>> = [];
  if (points.length >= 2) {
    const line = tool === 'area' && points.length >= 3 ? [...points, points[0]] : [...points];
    features.push({ type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates: line } });
  }
  for (const point of points) features.push({ type: 'Feature', properties: { role: 'corner' }, geometry: { type: 'Point', coordinates: point } });
  return { type: 'FeatureCollection', features };
}

/** One label point per annotation: the marker itself, or an area's middle. */
export function annotationLabelFeatures(items: readonly MapAnnotation[]): FeatureCollection<Geometry, { id: string; name: string; kind: AnnotationKind }> {
  return {
    type: 'FeatureCollection',
    features: items.map((item) => ({
      type: 'Feature',
      properties: { id: item.id, name: item.name, kind: item.kind },
      geometry: { type: 'Point', coordinates: annotationCentre(item) },
    })),
  };
}
