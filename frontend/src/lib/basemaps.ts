/**
 * Basemap styles of the Dashboard map.
 *
 * Every style draws raster tiles from the console's own `/api/tiles/<source>`
 * route. The console fetches each tile once from the source's upstream and
 * keeps it on disk (tools/tile_cache.py), so the browser never contacts a tile
 * provider, the page CSP lists no tile host, and an area shown before stays
 * visible while the console is offline. Host fallback happens on the server;
 * the browser sees one URL per source.
 *
 * Light and Dark need no provider of their own: they repaint the Standard
 * tiles with MapLibre raster paint (Dark inverts them, because
 * raster-brightness-min above raster-brightness-max maps light to dark, then
 * the hue rotation puts water and parks back in their own colours).
 *
 * Style labels name the look only; the attribution line names the data and
 * imagery sources, as their licences require.
 */
import type { RasterLayerSpecification, RasterSourceSpecification } from 'maplibre-gl';
import type { MessageKey } from './i18n';
import { preferenceStorage } from './preferenceStore';

export const BASEMAP_STORAGE_KEY = 'sdr-console-basemap';
/** Same-origin tile route, served by tools/ground_console.py. */
export const TILE_ROUTE = '/api/tiles';

export type TileSourceId = 'osm' | 'hot' | 'imagery' | 'imagery-labels' | 'topo';

/**
 * Tile sources the console serves, with the highest zoom each upstream has.
 * MapLibre overzooms past it instead of asking for tiles that do not exist.
 * Must equal TILE_SOURCES in tools/tile_cache.py (tools/test_basemap_contract.py).
 */
export const TILE_SOURCES: Readonly<Record<TileSourceId, { readonly maxzoom: number }>> = {
  osm: { maxzoom: 19 },
  hot: { maxzoom: 19 },
  imagery: { maxzoom: 18 },
  'imagery-labels': { maxzoom: 18 },
  topo: { maxzoom: 17 },
};

export type BasemapId = 'standard' | 'hot' | 'light' | 'dark' | 'satellite' | 'hybrid' | 'topo' | 'plain';
/** Whether the drawn tiles are mostly light or dark; reference lines follow it. */
export type BasemapTone = 'light' | 'dark';

export interface BasemapRasterPaint {
  'raster-saturation'?: number;
  'raster-contrast'?: number;
  'raster-brightness-min'?: number;
  'raster-brightness-max'?: number;
  'raster-hue-rotate'?: number;
}

export interface BasemapLayer {
  source: TileSourceId;
  paint?: BasemapRasterPaint;
}

export interface BasemapAttribution {
  /** Full credit line, also the chip's title. */
  text: string;
  /** Parts shown as links, in order. */
  links: ReadonlyArray<{ text: string; href: string }>;
}

export interface BasemapStyle {
  id: BasemapId;
  labelKey: MessageKey;
  tone: BasemapTone;
  /** Base layer first, then reference layers drawn over it. Empty for Plain. */
  layers: readonly BasemapLayer[];
  attribution: BasemapAttribution | null;
}

const OSM_LINK = { text: '© OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' } as const;
const OSM_ATTRIBUTION: BasemapAttribution = { text: '© OpenStreetMap contributors', links: [OSM_LINK] };
const ESRI_LINK = { text: 'Powered by Esri', href: 'https://www.esri.com/' } as const;
const IMAGERY_LINK = { text: 'Esri, Maxar, Earthstar Geographics', href: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9' } as const;

export const BASEMAPS: Readonly<Record<BasemapId, BasemapStyle>> = {
  standard: { id: 'standard', labelKey: 'basemap.standard', tone: 'light', layers: [{ source: 'osm' }], attribution: OSM_ATTRIBUTION },
  hot: {
    id: 'hot',
    labelKey: 'basemap.hot',
    tone: 'light',
    layers: [{ source: 'hot' }],
    attribution: {
      text: '© OpenStreetMap contributors · Humanitarian OpenStreetMap Team · OpenStreetMap France',
      links: [OSM_LINK, { text: 'HOT', href: 'https://www.hotosm.org/' }, { text: 'OSM France', href: 'https://www.openstreetmap.fr/' }],
    },
  },
  light: {
    id: 'light',
    labelKey: 'basemap.light',
    tone: 'light',
    layers: [{ source: 'osm', paint: { 'raster-saturation': -0.85, 'raster-contrast': -0.2, 'raster-brightness-min': 0.32 } }],
    attribution: OSM_ATTRIBUTION,
  },
  dark: {
    id: 'dark',
    labelKey: 'basemap.dark',
    tone: 'dark',
    layers: [{ source: 'osm', paint: { 'raster-hue-rotate': 180, 'raster-saturation': -0.6, 'raster-contrast': -0.1, 'raster-brightness-min': 0.86, 'raster-brightness-max': 0.08 } }],
    attribution: OSM_ATTRIBUTION,
  },
  satellite: {
    id: 'satellite',
    labelKey: 'basemap.satellite',
    tone: 'dark',
    // Slightly muted so the beam and lobe stand out on the imagery.
    layers: [{ source: 'imagery', paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.85 } }],
    attribution: { text: 'Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community', links: [ESRI_LINK, IMAGERY_LINK] },
  },
  hybrid: {
    id: 'hybrid',
    labelKey: 'basemap.hybrid',
    tone: 'dark',
    layers: [{ source: 'imagery', paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.85 } }, { source: 'imagery-labels' }],
    attribution: {
      text: 'Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community · Labels: Esri, HERE, Garmin, © OpenStreetMap contributors',
      links: [ESRI_LINK, IMAGERY_LINK, OSM_LINK],
    },
  },
  topo: {
    id: 'topo',
    labelKey: 'basemap.topo',
    tone: 'light',
    layers: [{ source: 'topo' }],
    attribution: {
      text: '© OpenStreetMap contributors · SRTM · © OpenTopoMap (CC-BY-SA)',
      links: [OSM_LINK, { text: '© OpenTopoMap (CC-BY-SA)', href: 'https://opentopomap.org/about' }],
    },
  },
  plain: { id: 'plain', labelKey: 'basemap.plain', tone: 'light', layers: [], attribution: null },
};

/** Menu order. */
export const BASEMAP_ORDER: readonly BasemapId[] = ['standard', 'hot', 'light', 'dark', 'satellite', 'hybrid', 'topo', 'plain'];
export const DEFAULT_BASEMAP_ID: BasemapId = 'standard';

export function isBasemapId(value: unknown): value is BasemapId {
  return typeof value === 'string' && value.length <= 32 && Object.prototype.hasOwnProperty.call(BASEMAPS, value);
}

export function normalizeBasemapId(value: unknown): BasemapId {
  return isBasemapId(value) ? value : DEFAULT_BASEMAP_ID;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadBasemapId(storage: StorageLike | null = preferenceStorage()): BasemapId {
  if (!storage) return DEFAULT_BASEMAP_ID;
  try {
    return normalizeBasemapId(storage.getItem(BASEMAP_STORAGE_KEY));
  } catch {
    return DEFAULT_BASEMAP_ID;
  }
}

export function saveBasemapId(id: BasemapId, storage: StorageLike | null = preferenceStorage()): void {
  if (!storage || !isBasemapId(id)) return;
  try {
    storage.setItem(BASEMAP_STORAGE_KEY, id);
  } catch {
    // The choice still applies for this page session.
  }
}

/** The tile source of the style's base layer, or null for Plain. */
export function basemapBaseSource(id: BasemapId): TileSourceId | null {
  return BASEMAPS[id].layers[0]?.source ?? null;
}

/** MapLibre source and layer id of one basemap layer: 'bm-<style>' for the base, 'bm-<style>-<n>' above it. */
export function basemapSourceId(id: BasemapId, index = 0): string {
  return index === 0 ? `bm-${id}` : `bm-${id}-${index}`;
}

export function isBasemapSourceId(sourceId: string): boolean {
  return /^bm-[a-z]+(?:-\d)?$/u.test(sourceId) && isBasemapId(sourceId.slice(3).replace(/-\d$/u, ''));
}

/** Tile URL template of a source on this console; the origin makes it absolute for MapLibre. */
export function tileUrlTemplate(source: TileSourceId, origin = ''): string {
  return `${origin}${TILE_ROUTE}/${source}/{z}/{x}/{y}`;
}

export interface BasemapRasterLayer {
  id: string;
  source: RasterSourceSpecification;
  layer: RasterLayerSpecification;
}

/** The raster sources and layers of a style, base first; empty for Plain. */
export function basemapRasterLayers(id: BasemapId, origin = '', reducedMotion = false): BasemapRasterLayer[] {
  const style = BASEMAPS[id];
  return style.layers.map((spec, index) => {
    const sourceId = basemapSourceId(id, index);
    return {
      id: sourceId,
      source: {
        type: 'raster',
        tiles: [tileUrlTemplate(spec.source, origin)],
        tileSize: 256,
        maxzoom: TILE_SOURCES[spec.source].maxzoom,
        ...(index === 0 && style.attribution ? { attribution: style.attribution.text } : {}),
      },
      layer: {
        id: sourceId,
        type: 'raster',
        source: sourceId,
        paint: { ...spec.paint, 'raster-fade-duration': reducedMotion ? 0 : 300 },
      },
    };
  });
}
