import type { MessageKey } from './i18n';
import { OSM_TILE_TEMPLATES } from './map';

/**
 * Basemap registry. Online hosts must match BASEMAP_TILE_HOSTS in
 * tools/ground_console.py, which builds the CSP. Light and dark are the
 * standard OSM tiles recoloured by MapLibre raster paint, so they add no
 * provider. Offline basemaps come from local MBTiles files served at
 * /api/tiles/<id>/{z}/{x}/{y}.
 */
export type OnlineBasemapId = 'osm' | 'osm-light' | 'osm-dark' | 'osm-hot' | 'esri-imagery';
export type BasemapId = OnlineBasemapId | `mbtiles:${string}`;

export interface RasterPaint {
  'raster-saturation'?: number;
  'raster-contrast'?: number;
  'raster-brightness-min'?: number;
  'raster-brightness-max'?: number;
  'raster-hue-rotate'?: number;
}

export interface BasemapSpec {
  id: BasemapId;
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  bounds?: [number, number, number, number];
  attribution: string;
  paint: RasterPaint;
}

export interface OnlineBasemap extends BasemapSpec {
  id: OnlineBasemapId;
  labelKey: MessageKey;
}

export interface TileSet {
  id: string;
  name: string;
  format: string;
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number] | null;
  attribution: string;
}

const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

export const ONLINE_BASEMAPS: readonly OnlineBasemap[] = [
  { id: 'osm', labelKey: 'basemap.osm', tiles: [...OSM_TILE_TEMPLATES], minzoom: 0, maxzoom: 19, attribution: OSM_ATTRIBUTION, paint: {} },
  {
    id: 'osm-light',
    labelKey: 'basemap.osmLight',
    tiles: [...OSM_TILE_TEMPLATES],
    minzoom: 0,
    maxzoom: 19,
    attribution: OSM_ATTRIBUTION,
    paint: { 'raster-saturation': -0.85, 'raster-contrast': -0.15, 'raster-brightness-min': 0.12 },
  },
  {
    id: 'osm-dark',
    labelKey: 'basemap.osmDark',
    tiles: [...OSM_TILE_TEMPLATES],
    minzoom: 0,
    maxzoom: 19,
    attribution: OSM_ATTRIBUTION,
    // brightness-min above brightness-max inverts luminance; the hue rotation
    // puts water and parks back near their usual colours.
    paint: { 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 180, 'raster-saturation': -0.55, 'raster-contrast': 0.1 },
  },
  {
    id: 'osm-hot',
    labelKey: 'basemap.osmHot',
    tiles: ['a', 'b', 'c'].map((sub) => `https://${sub}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png`),
    minzoom: 0,
    maxzoom: 19,
    attribution: `${OSM_ATTRIBUTION}, style: Humanitarian OpenStreetMap Team, hosted by OpenStreetMap France`,
    paint: {},
  },
  {
    id: 'esri-imagery',
    labelKey: 'basemap.esriImagery',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    minzoom: 0,
    maxzoom: 19,
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    paint: {},
  },
];

export const DEFAULT_BASEMAP: OnlineBasemapId = 'osm';
const STORAGE_KEY = 'sdr-console-basemap';
const TILE_SET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function mbtilesBasemapId(tileSetId: string): BasemapId {
  return `mbtiles:${tileSetId}`;
}

/** Resolve a stored or chosen id to a renderable spec; unknown ids fall back to OSM. */
export function resolveBasemap(id: string, tileSets: readonly TileSet[], origin: string): BasemapSpec {
  const online = ONLINE_BASEMAPS.find((basemap) => basemap.id === id);
  if (online) return online;
  if (id.startsWith('mbtiles:')) {
    const tileSet = tileSets.find((item) => item.id === id.slice('mbtiles:'.length));
    if (tileSet) {
      return {
        id: mbtilesBasemapId(tileSet.id),
        // Absolute URL: MapLibre may fetch tiles from a worker, where a bare
        // path would not resolve against the page.
        tiles: [`${origin}/api/tiles/${encodeURIComponent(tileSet.id)}/{z}/{x}/{y}`],
        minzoom: tileSet.minzoom,
        maxzoom: tileSet.maxzoom,
        ...(tileSet.bounds ? { bounds: tileSet.bounds } : {}),
        attribution: tileSet.attribution || tileSet.name,
        paint: {},
      };
    }
  }
  return ONLINE_BASEMAPS[0];
}

export function normalizeTileSets(value: unknown): TileSet[] {
  const items = value && typeof value === 'object' ? (value as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  const result: TileSet[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !TILE_SET_ID.test(item.id)) continue;
    const zoom = (input: unknown, fallback: number) => (typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= 24 ? input : fallback);
    const minzoom = zoom(item.minzoom, 0);
    const maxzoom = Math.max(minzoom, zoom(item.maxzoom, 19));
    const bounds = Array.isArray(item.bounds) && item.bounds.length === 4 && item.bounds.every((part) => typeof part === 'number' && Number.isFinite(part))
      ? item.bounds as [number, number, number, number]
      : null;
    result.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : item.id,
      format: typeof item.format === 'string' ? item.format : 'png',
      minzoom,
      maxzoom,
      bounds,
      attribution: typeof item.attribution === 'string' ? item.attribution.slice(0, 300) : '',
    });
  }
  return result;
}

export function loadBasemapChoice(): BasemapId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? '';
    if (ONLINE_BASEMAPS.some((basemap) => basemap.id === stored)) return stored as OnlineBasemapId;
    if (stored.startsWith('mbtiles:') && TILE_SET_ID.test(stored.slice('mbtiles:'.length))) return stored as BasemapId;
  } catch {
    /* Storage may be disabled. */
  }
  return DEFAULT_BASEMAP;
}

export function saveBasemapChoice(id: BasemapId): void {
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* local persistence is optional */ }
}
