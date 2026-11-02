import { describe, expect, it, vi } from 'vitest';
import { BASEMAPS, basemapSourceId, type BasemapId } from './basemaps';
import {
  OFFLINE_GLYPHS_PATH,
  OFFLINE_LAYER_PREFIX,
  OFFLINE_MAP_PATH,
  basemapContents,
  offlineLayers,
  offlineSource,
  registerOfflineProtocol,
} from './offlineBasemap';

const ORIGIN = 'http://127.0.0.1:8787';

describe('offline basemap', () => {
  it('reads one PMTiles archive from this console, with an absolute pmtiles URL', () => {
    const { id, source } = offlineSource(ORIGIN, basemapSourceId('offline'));
    expect(id).toBe('bm-offline');
    expect(source).toEqual({ type: 'vector', url: `pmtiles://${ORIGIN}/api/maps/offline.pmtiles` });
    expect(OFFLINE_MAP_PATH).toBe('/api/maps/offline.pmtiles');
  });

  it('draws every layer from that source, under ids that no other layer uses', () => {
    const layers = offlineLayers('bm-offline');
    expect(layers.length).toBeGreaterThan(40);
    const ids = layers.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const layer of layers) {
      expect(layer.id.startsWith(OFFLINE_LAYER_PREFIX)).toBe(true);
      expect((layer as { source?: string }).source).toBe('bm-offline');
    }
  });

  it('takes out the layers that need a sprite sheet or a solid background, and every icon', () => {
    const layers = offlineLayers('bm-offline');
    const names = layers.map((layer) => layer.id.slice(OFFLINE_LAYER_PREFIX.length));
    for (const skipped of ['background', 'roads_oneway', 'roads_shields']) expect(names).not.toContain(skipped);
    for (const layer of layers) {
      const layout = ('layout' in layer ? layer.layout : undefined) as Record<string, unknown> | undefined;
      expect(layout?.['icon-image'], layer.id).toBeUndefined();
    }
    // Labels stay.
    expect(names).toContain('pois');
    expect(names).toContain('places_locality');
  });

  it('asks only for glyph directories the console ships (no spaces, which the static route refuses)', () => {
    // text-font is a list or an expression that holds lists; read every font name in it.
    const text = JSON.stringify(offlineLayers('bm-offline').map((layer) => (('layout' in layer ? layer.layout : undefined) as Record<string, unknown> | undefined)?.['text-font']));
    expect(text).not.toContain('Noto Sans');
    expect([...new Set(text.match(/NotoSans-[A-Za-z]+/g))].sort()).toEqual(['NotoSans-Italic', 'NotoSans-Medium', 'NotoSans-Regular']);
    expect(OFFLINE_GLYPHS_PATH).toBe('/assets/map-fonts/{fontstack}/{range}.pbf');
  });

  it('is the one source and layer list of the Offline style, and raster layers for the others', () => {
    const offline = basemapContents('offline', ORIGIN);
    expect(offline).toHaveLength(1);
    expect(offline[0].id).toBe('bm-offline');
    expect(offline[0].source.type).toBe('vector');
    expect(offline[0].layers.length).toBeGreaterThan(40);
    const hybrid = basemapContents('hybrid', ORIGIN);
    expect(hybrid.map((content) => content.id)).toEqual(['bm-hybrid', 'bm-hybrid-1']);
    expect(hybrid.every((content) => content.source.type === 'raster' && content.layers.length === 1)).toBe(true);
    expect(basemapContents('plain', ORIGIN)).toEqual([]);
    for (const id of Object.keys(BASEMAPS) as BasemapId[]) expect(Array.isArray(basemapContents(id, ORIGIN))).toBe(true);
  });

  it('registers the pmtiles protocol once', () => {
    const add = vi.fn();
    registerOfflineProtocol(add);
    registerOfflineProtocol(add);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe('pmtiles');
    expect(typeof add.mock.calls[0][1]).toBe('function');
  });
});
