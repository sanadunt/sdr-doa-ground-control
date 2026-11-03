import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LineString } from 'geojson';
import { OverlayLegend } from '../components/OverlayLegend';
import type { TelemetrySnapshot } from '../types';
import { DEFAULT_DOA_OVERLAY_SETTINGS, bearingAndDistance, type DbScale, type DoaOverlaySettings } from './doaGeometry';
import {
  HELD_LAYER_OF,
  heldBearingDeg,
  heldLayerSpec,
  heldNoticeText,
  heldOverlayFeatures,
  overlayIdentity,
  provisionalBesideHeld,
  rememberOverlay,
  type LiveOverlay,
  type OverlayIdentity,
  type OverlayMemory,
} from './heldOverlay';
import { I18nContext, translate } from './i18n';
import type { Lang, Translate } from './i18n';
import { paletteGradientCss } from './overlayPalette';

type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
function readText(path: string): string {
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

function tr(lang: Lang): Translate {
  return (key, vars) => translate(lang, key, vars);
}

function markup(node: JSX.Element, lang: Lang = 'en'): string {
  return renderToStaticMarkup(<I18nContext.Provider value={{ lang, setLang: () => undefined, t: tr(lang) }}>{node}</I18nContext.Provider>);
}

function vector(peak = 40): number[] {
  return Array.from({ length: 360 }, (_, bin) => (bin === peak ? 0 : -30 + 10 * Math.cos(((bin - peak) * Math.PI) / 180)));
}

const NODE: OverlayIdentity = { baseUrl: 'http://192.168.100.100:8081', sid: 'a1b2c3d4', uptimeMs: 10_000 };
const STATION = { latitude: -6.2, longitude: 106.8 };
const live = (values = vector(), extra: Partial<LiveOverlay> = {}): LiveOverlay => ({ values, thetaDeg: 40, offsetDeg: 10, frequencyHz: 433_920_000, origin: { ...STATION }, ...extra });
const step = (previous: OverlayMemory | null, input: Partial<Parameters<typeof rememberOverlay>[1]> = {}) =>
  rememberOverlay(previous, { live: null, liveBearing: false, identity: NODE, simulation: false, nowMs: 2_000, ...input });

describe('rememberOverlay: the map keeps its last live overlay like the polar dock', () => {
  it('remembers a live overlay with the time it arrived and draws nothing held', () => {
    const values = vector();
    const first = step(null, { live: live(values), nowMs: 1_000 });
    expect(first.draw).toBeNull();
    expect(first.memory?.overlay).toEqual({ ...live(values), atMs: 1_000 });
    // The same record again keeps the same memory object, so the map rebuilds nothing.
    const again = step(first.memory, { live: live(values), nowMs: 1_500 });
    expect(again.memory).toBe(first.memory);
    // A new record moves the time.
    const next = step(first.memory, { live: live(vector(41)), nowMs: 1_800 });
    expect(next.memory?.overlay?.atMs).toBe(1_800);
  });

  it('draws the remembered overlay while no live one exists, with no time cutoff', () => {
    const remembered = step(null, { live: live(), nowMs: 1_000 }).memory;
    const held = step(remembered, { nowMs: 1_000 + 86_400_000 });
    expect(held.draw).toBe(remembered?.overlay);
    expect(held.memory).toBe(remembered);
    // Live data returning replaces it at once.
    expect(step(held.memory, { live: live(vector(90)), nowMs: 5_000 }).draw).toBeNull();
  });

  it('draws nothing held while a live bearing is drawn without the curve (MQTT between Angular frames)', () => {
    const remembered = step(null, { live: live(), nowMs: 1_000 }).memory;
    const between = step(remembered, { liveBearing: true });
    expect(between.draw).toBeNull();
    expect(between.memory).toBe(remembered);
  });

  it('never remembers or draws a simulation', () => {
    expect(step(null, { live: live(), simulation: true }).memory).toBeNull();
    const remembered = step(null, { live: live(), nowMs: 1_000 }).memory;
    const simulated = step(remembered, { live: live(vector(200)), simulation: true });
    expect(simulated.memory).toBe(remembered);
    expect(step(remembered, { simulation: true })).toEqual({ draw: null, memory: remembered });
  });

  it('forgets the overlay for another node or a restart of the same one', () => {
    const remembered = step(null, { live: live(), nowMs: 1_000 }).memory;
    expect(step(remembered, { identity: { ...NODE, sid: 'ffff0000' } })).toEqual({ draw: null, memory: { overlay: null, identity: { ...NODE, sid: 'ffff0000' } } });
    expect(step(remembered, { identity: { ...NODE, baseUrl: 'http://10.0.0.9:8081' } }).draw).toBeNull();
    expect(step(remembered, { identity: { ...NODE, uptimeMs: 500 } }).draw).toBeNull();
    // An answer that does not carry a field decides nothing; an advancing uptime keeps it.
    const quiet = step(remembered, { identity: { baseUrl: null, sid: null, uptimeMs: null } });
    expect(quiet.draw).toBe(remembered?.overlay);
    const later = step(remembered, { identity: { ...NODE, uptimeMs: 20_000 } });
    expect(later.draw).toBe(remembered?.overlay);
    expect(later.memory?.identity.uptimeMs).toBe(20_000);
    // The uptime seen last counts: going back from 20 s to 15 s is a restart.
    expect(step(later.memory, { identity: { ...NODE, uptimeMs: 15_000 } }).draw).toBeNull();
  });

  it('reads the node from an answer', () => {
    const answer = JSON.parse(readText('../../../tools/fixtures/telemetry-source/mqtt-live.json')) as TelemetrySnapshot;
    expect(overlayIdentity(answer)).toEqual({ baseUrl: 'http://127.0.0.1:8081', sid: '227c8be2', uptimeMs: null });
    expect(overlayIdentity({ status: { safe: { uptime_ms: 1234 } } } as unknown as TelemetrySnapshot).uptimeMs).toBe(1234);
    expect(overlayIdentity(null)).toEqual({ baseUrl: null, sid: null, uptimeMs: null });
  });
});

describe('held overlay geometry', () => {
  const origin = STATION;
  const draw: DoaOverlaySettings = { ...DEFAULT_DOA_OVERLAY_SETTINGS, minDb: -40, maxDb: 0, thresholdDb: -40 };
  const held = { ...live(), atMs: 1_000 };

  it('fills only the held sources, drawn with the remembered compass offset', () => {
    const features = heldOverlayFeatures(held, draw);
    expect(Object.keys(features).sort()).toEqual(['doa-held-beam', 'doa-held-bearing', 'doa-held-edges', 'doa-held-heat', 'doa-held-lobe', 'halfPower']);
    expect(features['doa-held-lobe'].features).toHaveLength(1);
    expect(features['doa-held-bearing'].features).toHaveLength(1);
    expect(features.halfPower).not.toBeNull();
    // theta_0 40° with offset 10° is the geographic bearing 330°.
    expect(heldBearingDeg(held)).toBeCloseTo(330, 6);
    const line = features['doa-held-bearing'].features[0].geometry as LineString;
    const end = line.coordinates[line.coordinates.length - 1];
    expect(bearingAndDistance(origin, end[0], end[1]).bearingDeg).toBeCloseTo(330, 0);
  });

  it('turns the held curve with its own frame heading and the bearing with the compass offset', () => {
    // Contract 1.10: the Angular frame carries its own heading, which may differ from the DoA's.
    const turned = { ...held, curveOffsetDeg: 50 };
    const same = heldOverlayFeatures(held, draw)['doa-held-lobe'];
    const moved = heldOverlayFeatures(turned, draw)['doa-held-lobe'];
    expect(moved).not.toEqual(same);
    expect(heldOverlayFeatures({ ...held, curveOffsetDeg: 10 }, draw)['doa-held-lobe']).toEqual(same);
    expect(heldBearingDeg(turned)).toBeCloseTo(330, 6);
    // A new frame heading is a new live overlay to remember.
    const first = step(null, { live: live(), nowMs: 1_000 });
    const next = step(first.memory, { live: live(first.memory?.overlay?.values, { curveOffsetDeg: 50 }), nowMs: 2_000 });
    expect(next.memory?.overlay?.curveOffsetDeg).toBe(50);
  });

  it('stays where it was measured while the station moves on', () => {
    // Live at A; the DoA stops and the RDF-SDR drives about 2 km north to B.
    const atA = step(null, { live: live(), nowMs: 1_000 });
    const stopped = step(atA.memory, { nowMs: 5_000 });
    expect(stopped.draw?.origin).toEqual(STATION);
    const features = heldOverlayFeatures(stopped.draw, draw);
    const line = features['doa-held-bearing'].features[0].geometry as LineString;
    expect(line.coordinates[0][0]).toBeCloseTo(STATION.longitude, 6);
    expect(line.coordinates[0][1]).toBeCloseTo(STATION.latitude, 6);
    // Live again at B: the memory takes the new origin.
    const atB = step(stopped.memory, { live: live(undefined, { origin: { latitude: -6.18, longitude: 106.8 } }), nowMs: 6_000 });
    expect(atB.memory?.overlay?.origin).toEqual({ latitude: -6.18, longitude: 106.8 });
  });

  it('follows the layer switches and draws nothing without a memory', () => {
    const density = heldOverlayFeatures(held, { ...draw, heatStyle: 'density' });
    expect(density['doa-held-beam'].features).toHaveLength(0);
    expect(density['doa-held-heat'].features.length).toBeGreaterThan(0);
    const off = heldOverlayFeatures(held, { ...draw, lobeVisible: false, bearingVisible: false, edgesVisible: false, heatmapVisible: false });
    expect(off['doa-held-lobe'].features.length + off['doa-held-bearing'].features.length + off['doa-held-edges'].features.length + off['doa-held-beam'].features.length).toBe(0);
    expect(heldOverlayFeatures(null, draw)['doa-held-lobe'].features).toHaveLength(0);
    expect(heldOverlayFeatures({ ...held, thetaDeg: null }, draw)['doa-held-bearing'].features).toHaveLength(0);
  });

  it('draws the NOT VALID line beside the held bearing only more than 3° away', () => {
    expect(provisionalBesideHeld(null, 330)).toBe(false);
    expect(provisionalBesideHeld(120, null)).toBe(true);
    expect(provisionalBesideHeld(332, 330)).toBe(false);
    expect(provisionalBesideHeld(333, 330)).toBe(false);
    expect(provisionalBesideHeld(334, 330)).toBe(true);
    expect(provisionalBesideHeld(1, 359)).toBe(false);
    expect(provisionalBesideHeld(5, 359)).toBe(true);
  });
});

describe('held overlay text', () => {
  it('names the held overlay, its time and the cause in both languages', () => {
    expect(heldNoticeText(tr('en'), '20:27:52', 'Data stale')).toBe('DoA held · last 20:27:52 · Data stale');
    expect(heldNoticeText(tr('id'), '20.27.52', 'Data basi')).toBe('DoA ditahan · terakhir 20.27.52 · Data basi');
    expect(heldNoticeText(tr('en'), '20:27:52', undefined)).toBe('DoA held · last 20:27:52 · no fresh 360-bin vector');
    expect(heldNoticeText(tr('id'), '20.27.52', undefined)).toBe('DoA ditahan · terakhir 20.27.52 · tidak ada vektor 360 bin yang fresh');
    expect(translate('en', 'map.heldBearing', { deg: '330.0', time: '20:27:52' })).toBe('STALE 330.0° · last 20:27:52');
    expect(translate('id', 'map.heldBearing', { deg: '330.0', time: '20.27.52' })).toBe('USANG 330.0° · terakhir 20.27.52');
  });

  it('leads the legend with STALE and the time, its swatches and scale in the live colours', () => {
    const scale: DbScale = { minDb: -40, maxDb: 0, thresholdDb: -40, mode: 'auto', known: true };
    const legend = (heldTime: string | null, lang: Lang = 'en') => markup(<OverlayLegend settings={DEFAULT_DOA_OVERLAY_SETTINGS} scale={scale} saturation={0} ringStepM={250} halfPower={{ widthDeg: 30 } as never} heldTime={heldTime} />, lang);
    const held = legend('20:27:52');
    expect(held).toContain('<span class="legend-held">STALE · last 20:27:52</span>');
    expect(legend('20.27.52', 'id')).toContain('USANG · terakhir 20.27.52');
    // Apart from the tag, the held legend is the live one: no grey swatch, the live palette.
    const liveLegend = legend(null);
    expect(liveLegend).not.toContain('legend-held');
    expect(held.replace('<span class="legend-held">STALE · last 20:27:52</span>', '')).toBe(liveLegend);
    expect(held).not.toContain('is-held');
    expect(held).toContain(paletteGradientCss(DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette).replace(/"/gu, '&quot;'));
    expect(held).not.toContain('rgba(154, 166, 178');
  });
});

describe('the held overlay keeps the live paint (owner\'s decision of 2026-11-02)', () => {
  const source = readText('../components/TacticalMap.tsx');
  const css = readText('../console-design.css');

  it('mirrors every live DoA layer into a held layer on its own held source, with the same paint', () => {
    expect(Object.entries(HELD_LAYER_OF)).toEqual([
      ['doa-beam', 'doa-held-beam'],
      ['doa-heat', 'doa-held-heat'],
      ['doa-lobe-fill', 'doa-held-lobe-fill'],
      ['doa-lobe-outline', 'doa-held-lobe-outline'],
      ['doa-edges', 'doa-held-edges'],
      ['doa-bearing-casing', 'doa-held-bearing-casing'],
      ['doa-bearing', 'doa-held-bearing'],
    ]);
    const liveBearing = { id: 'doa-bearing', type: 'line', source: 'doa-bearing', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#e0603a', 'line-opacity': .95, 'line-width': 3 } } as const;
    const held = heldLayerSpec(liveBearing);
    expect(held).toEqual({ ...liveBearing, id: 'doa-held-bearing', source: 'doa-held-bearing' });
    // The very same paint and layout: solid, in the bearing colour, at the live opacity.
    expect(held.paint).toBe(liveBearing.paint);
    expect(held.layout).toBe(liveBearing.layout);
    expect(heldLayerSpec({ id: 'doa-lobe-fill', source: 'doa-lobe' }).source).toBe('doa-held-lobe');
    expect(heldLayerSpec({ id: 'doa-bearing-casing', source: 'doa-bearing' })).toEqual({ id: 'doa-held-bearing-casing', source: 'doa-held-bearing' });
    expect(() => heldLayerSpec({ id: 'doa-rings', source: 'doa-rings' })).toThrow();
  });

  it('builds the held layers from the live specifications and sends every paint change to both', () => {
    // No held layer is written by hand, and nothing grey or faint is left for it.
    expect(source).not.toMatch(/\{ id: 'doa-held-/u);
    for (const key of ['beam', 'heat', 'lobeFill', 'lobeOutline', 'edges', 'bearingCasing', 'bearing']) expect(source).toContain(`heldLayerSpec(doaLayers.${key})`);
    expect(source).not.toMatch(/HELD_OPACITY|heldColor|heldHeatmapColor|heldRgba|HELD_BEARING_DASH/u);
    // Palette, opacity, intensity and blur reach the held layers through setDoaPaint().
    expect(source).not.toMatch(/map\.setPaintProperty\('doa-(beam|heat|lobe|edges|bearing)/u);
    for (const property of ["'doa-beam', 'fill-color'", "'doa-beam', 'fill-opacity'", "'doa-heat', 'heatmap-color'", "'doa-heat', 'heatmap-radius'", "'doa-heat', 'heatmap-opacity'", "'doa-heat', 'heatmap-intensity'", "'doa-lobe-fill', 'fill-opacity'", "'doa-edges', 'line-color'", "'doa-lobe-outline', 'line-color'"]) expect(source).toContain(`setDoaPaint(map, ${property}`);
    expect(source).toContain('setDoaPaint(map, id, property, base * (CURVE_LINE_LAYERS.has(id) ? curveLayerFade : fade))');
    // The canvas fallback draws the held lobe, edges and bearing with the live strokes.
    expect(source).toContain("drawDirection(geometry.data['doa-held-lobe'], geometry.data['doa-held-edges'], geometry.data['doa-held-bearing'])");
  });

  it('keeps STALE and the time of the last data on the label, the readout and the notice', () => {
    // The held bearing label is the live label; its text carries STALE and the time.
    expect(source).toContain("'doa-bearing-label', t('map.heldBearing'");
    expect(source).not.toContain("'doa-bearing-label is-held'");
    expect(css).not.toMatch(/\.doa-bearing-label\.is-held|\.legend-swatch\.is-held|\.legend-bearing\.is-held|\.map-overlay-legend\.is-held/u);
    // The hover readout's STALE line with the time.
    expect(source).toContain("<span class=\"is-held\">${t('map.legendHeld', { time: readoutHeld })}</span>");
    expect(translate('en', 'map.legendHeld', { time: '20:27:52' })).toBe('STALE · last 20:27:52');
    expect(source).toContain('heldNoticeText(t, heldTime');
  });
});
