/**
 * The Offline basemap: vector tiles from one PMTiles archive on the console
 * host (`GET /api/maps/offline.pmtiles`, tools/map_files.py), drawn with the
 * Protomaps "light" layers. Nothing is fetched from a provider while the map
 * is shown; the archive and the glyph files (public/assets/map-fonts) both
 * come from this console, so the style works without internet and from the
 * LAN view.
 *
 * Kept apart from basemaps.ts so the catalogue stays plain data; the layer
 * list and the pmtiles reader load with the map's own chunk.
 */
import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';
import type { LayerSpecification, SourceSpecification, VectorSourceSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { BASEMAPS, basemapRasterLayers, basemapSourceId, type BasemapId } from './basemaps';

/** Same-origin range route of the archive (tools/map_files.py OFFLINE_MAP_ROUTE). */
export const OFFLINE_MAP_PATH = '/api/maps/offline.pmtiles';
/** Glyph ranges the Protomaps layers need; static assets of the built UI. */
export const OFFLINE_GLYPHS_PATH = '/assets/map-fonts/{fontstack}/{range}.pbf';
/** Prefix of every layer id of the style, so a swap removes exactly these. */
export const OFFLINE_LAYER_PREFIX = 'bm-offline.';

// The glyph directories have no spaces: the console's static route refuses '%'.
const FONT_DIRECTORIES: Readonly<Record<string, string>> = {
  'Noto Sans Regular': 'NotoSans-Regular',
  'Noto Sans Medium': 'NotoSans-Medium',
  'Noto Sans Italic': 'NotoSans-Italic',
};
// Layers that need a sprite sheet the console does not ship (arrows and road
// shields), or that fill the whole map with a colour (the console draws its own).
const SKIPPED_LAYERS: ReadonlySet<string> = new Set(['background', 'roads_oneway', 'roads_shields']);
// Place and POI labels stay, without their icons.
const ICON_LAYOUT_KEYS = ['icon-image', 'icon-size', 'icon-anchor', 'icon-offset'] as const;

export function offlineSource(origin: string, sourceId: string): { id: string; source: VectorSourceSpecification } {
  return {
    id: sourceId,
    // No maxzoom here: the archive's own header sets it, and MapLibre draws the tiles larger beyond it.
    source: { type: 'vector', url: `pmtiles://${origin}${OFFLINE_MAP_PATH}` },
  };
}

/** The Protomaps light layers on `sourceId`, with local fonts and no sprite-only layers. */
export function offlineLayers(sourceId: string): LayerSpecification[] {
  const raw = protomapsLayers(sourceId, namedFlavor('light'), { lang: 'id' });
  const named = JSON.parse(
    JSON.stringify(raw).replace(/Noto Sans (Regular|Medium|Italic)/g, (match) => FONT_DIRECTORIES[match] ?? match),
  ) as LayerSpecification[];
  return named
    .filter((layer) => !SKIPPED_LAYERS.has(layer.id))
    .map((layer) => {
      const layout = 'layout' in layer && layer.layout ? { ...(layer.layout as Record<string, unknown>) } : undefined;
      if (layout) for (const key of ICON_LAYOUT_KEYS) delete layout[key];
      return { ...layer, id: OFFLINE_LAYER_PREFIX + layer.id, ...(layout ? { layout } : {}) } as LayerSpecification;
    });
}

let protocolRegistered = false;

/** Registers the `pmtiles://` protocol with MapLibre once; later calls do nothing. */
export function registerOfflineProtocol(addProtocol: (name: string, loader: Protocol['tile']) => void): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

/** One basemap source with the layers drawn from it, in drawing order. */
export interface BasemapContent {
  /** MapLibre source id: `bm-<style>` for the base, `bm-<style>-<n>` above it. */
  id: string;
  source: SourceSpecification;
  layers: LayerSpecification[];
}

/**
 * Everything a style adds to the map: the raster sources and layers of the
 * tile styles, or the archive's vector source and layers for Offline. Empty
 * for Plain.
 */
export function basemapContents(id: BasemapId, origin = '', reducedMotion = false): BasemapContent[] {
  if (BASEMAPS[id].offline) {
    const sourceId = basemapSourceId(id);
    const { source } = offlineSource(origin, sourceId);
    return [{ id: sourceId, source, layers: offlineLayers(sourceId) }];
  }
  return basemapRasterLayers(id, origin, reducedMotion).map((raster) => ({ id: raster.id, source: raster.source, layers: [raster.layer] }));
}
