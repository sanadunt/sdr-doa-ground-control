import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OverlayLegend } from '../components/OverlayLegend';
import { LayersPanel } from '../components/overview/LayersPanel';
import type { TelemetrySnapshot } from '../types';
import { DEFAULT_BASEMAP_ID } from './basemaps';
import { DEFAULT_DOA_OVERLAY_SETTINGS, bearingAndDistance, type DbScale } from './doaGeometry';
import { I18nContext, translate } from './i18n';
import type { Lang, Translate } from './i18n';
import { validateOverlaySettings } from './mapOverlaySettings';
import { headingLabel, headingLabelPosition, headingLineFeatures, headingPopupText, rdfHeading } from './rdfHeading';

/** An answer of tools/telemetry_source.py, written by tools/test_telemetry_source.py. */
function answer(name: string): TelemetrySnapshot {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/telemetry-source/${name}`, import.meta.url), 'utf8')) as TelemetrySnapshot;
}

// MQTT answers over Telemetry LoRa with nav: heading 201.1°, compass OK.
const NAV = answer('mqtt-lora-nav.json');
const RF = answer('mqtt-lora-rf.json');
// An MQTT answer without nav fields.
const LIVE = answer('mqtt-live.json');
const STATION = { latitude: -6.20576, longitude: 106.81 };

function withNav(patch: Record<string, unknown>): TelemetrySnapshot {
  return { ...NAV, nav: { ...(NAV.nav as Record<string, unknown>), ...patch } };
}

function tr(lang: Lang): Translate {
  return (key, vars) => translate(lang, key, vars);
}

function markup(node: JSX.Element, lang: Lang = 'en'): string {
  return renderToStaticMarkup(<I18nContext.Provider value={{ lang, setLang: () => undefined, t: tr(lang) }}>{node}</I18nContext.Provider>);
}

describe('rdfHeading', () => {
  it('reads the compass heading of a fresh MQTT answer as OK', () => {
    expect(rdfHeading(NAV, true)).toEqual({ headingDeg: 201.1, state: 'OK', compassState: 'OK' });
    expect(rdfHeading(RF, true)).toEqual({ headingDeg: 201.1, state: 'OK', compassState: 'OK' });
  });

  it('holds the heading as STALE once the answer is no longer fresh', () => {
    expect(rdfHeading(NAV, false)).toEqual({ headingDeg: 201.1, state: 'STALE', compassState: 'OK' });
  });

  it('names another compass state without a heading to draw', () => {
    expect(rdfHeading(withNav({ compass_state: 'NO_REPLY' }), true)).toEqual({ headingDeg: null, state: 'UNAVAILABLE', compassState: 'NO_REPLY' });
    expect(rdfHeading(withNav({ compass_state: 'NO_REPLY', heading_deg: null }), false)).toEqual({ headingDeg: null, state: 'UNAVAILABLE', compassState: 'NO_REPLY' });
    // A state that is not a code is not shown as one.
    expect(rdfHeading(withNav({ compass_state: '<b>x</b>' }), true)).toEqual({ headingDeg: null, state: 'UNAVAILABLE', compassState: null });
  });

  it('draws no heading out of [0, 360) or not a finite number', () => {
    for (const heading_deg of [360, -0.1, 400, Number.NaN, '201.1', null]) {
      expect(rdfHeading(withNav({ heading_deg }), true)).toMatchObject({ headingDeg: null, state: 'UNAVAILABLE' });
    }
    expect(rdfHeading(withNav({ heading_deg: 0 }), true)).toMatchObject({ headingDeg: 0, state: 'OK' });
    expect(rdfHeading(withNav({ heading_deg: 359.9 }), true)).toMatchObject({ headingDeg: 359.9, state: 'OK' });
  });

  it('is null for a Data Out answer, an answer without compass fields, a simulation or no snapshot', () => {
    expect(rdfHeading(LIVE, true)).toBeNull();
    expect(rdfHeading({ ...NAV, source: { ...(NAV.source as object), kind: 'data_out' } } as TelemetrySnapshot, true)).toBeNull();
    expect(rdfHeading(withNav({ compass_state: null, heading_deg: null }), true)).toBeNull();
    expect(rdfHeading({ ...NAV, simulation: true }, true)).toBeNull();
    expect(rdfHeading(null, true)).toBeNull();
    expect(rdfHeading(undefined, false)).toBeNull();
  });
});

describe('heading geometry', () => {
  it('draws one line from the station along the heading, as long as the bearing line', () => {
    const line = headingLineFeatures(STATION, rdfHeading(NAV, true), 1000);
    expect(line.features).toHaveLength(1);
    const [start, end] = line.features[0].geometry.coordinates;
    expect(start).toEqual([STATION.longitude, STATION.latitude]);
    const reach = bearingAndDistance(STATION, end[0], end[1]);
    expect(reach.bearingDeg).toBeCloseTo(201.1, 3);
    expect(reach.distanceM).toBeCloseTo(1000, 0);
    expect(line.features[0].properties).toMatchObject({ layer: 'rdf-heading', heading: 201.1, held: false });
  });

  it('marks a STALE heading held and draws nothing without a heading', () => {
    expect(headingLineFeatures(STATION, rdfHeading(NAV, false), 1000).features[0].properties).toMatchObject({ held: true });
    expect(headingLineFeatures(STATION, rdfHeading(withNav({ compass_state: 'NO_REPLY' }), true), 1000).features).toHaveLength(0);
    expect(headingLineFeatures(STATION, null, 1000).features).toHaveLength(0);
    expect(headingLineFeatures(STATION, rdfHeading(NAV, true), 0).features).toHaveLength(0);
  });

  it('puts the label past the line, or along it when a bearing points nearly the same way', () => {
    const far = headingLabelPosition(STATION, 201.1, 1000, [90, null]);
    expect(bearingAndDistance(STATION, far[0], far[1]).distanceM).toBeCloseTo(1100, 0);
    const near = headingLabelPosition(STATION, 201.1, 1000, [195]);
    expect(bearingAndDistance(STATION, near[0], near[1]).distanceM).toBeCloseTo(620, 0);
    // Across north: 355° and 5° are 10° apart.
    const wrap = headingLabelPosition(STATION, 355, 1000, [5]);
    expect(bearingAndDistance(STATION, wrap[0], wrap[1]).distanceM).toBeCloseTo(620, 0);
  });

  it('labels the heading in both languages, STALE/USANG when held', () => {
    const live = rdfHeading(NAV, true)!;
    const held = rdfHeading(NAV, false)!;
    expect(headingLabel(live, tr('en'))).toBe('HDG 201°');
    expect(headingLabel(live, tr('id'))).toBe('HDG 201°');
    expect(headingLabel(held, tr('en'))).toBe('HDG 201° · STALE');
    expect(headingLabel(held, tr('id'))).toBe('HDG 201° · USANG');
    expect(headingPopupText(live, 'Unavailable')).toBe('201.1°');
    expect(headingPopupText(held, 'Unavailable')).toBe('201.1° · STALE');
    expect(headingPopupText(held, 'Tidak tersedia', tr('id')('map.popupHeld'))).toBe('201.1° · USANG');
    expect(tr('id')('map.sourceHeld')).toBe('POSISI STASIUN TERAKHIR · USANG');
    expect(tr('en')('map.sourceHeld')).toBe('LAST STATION POSITION · STALE');
    expect(headingPopupText(rdfHeading(withNav({ compass_state: 'NO_REPLY' }), true)!, 'Unavailable')).toBe('NO_REPLY');
  });
});

describe('heading layer setting', () => {
  it('is on by default and on for a stored value from before the setting', () => {
    expect(DEFAULT_DOA_OVERLAY_SETTINGS.headingVisible).toBe(true);
    const legacy: Record<string, unknown> = { ...DEFAULT_DOA_OVERLAY_SETTINGS };
    delete legacy.headingVisible;
    expect(validateOverlaySettings(legacy).headingVisible).toBe(true);
    expect(validateOverlaySettings({ ...legacy, headingVisible: 'false' } as never).headingVisible).toBe(true);
    expect(validateOverlaySettings({ ...DEFAULT_DOA_OVERLAY_SETTINGS, headingVisible: false }).headingVisible).toBe(false);
  });

  it('has a switch in the Layers panel in both languages', () => {
    const panel = (lang: Lang, headingVisible: boolean) => markup(
      <LayersPanel settings={{ ...DEFAULT_DOA_OVERLAY_SETTINGS, headingVisible }} scale={{ minDb: -60, maxDb: 0, thresholdDb: -60, mode: 'auto', known: false }} onChange={() => undefined} onClose={() => undefined} basemapId={DEFAULT_BASEMAP_ID} onBasemapChange={() => undefined} />,
      lang,
    );
    expect(panel('en', true)).toMatch(/<input type="checkbox" checked=""\/><span>RDF-SDR heading<\/span>/u);
    expect(panel('id', true)).toContain('<span>Heading RDF-SDR</span>');
    expect(panel('en', false)).toMatch(/<input type="checkbox"\/><span>RDF-SDR heading<\/span>/u);
    // Eight layers and, since contract 1.10, the position estimate.
    expect(panel('en', true).match(/type="checkbox"/gu)).toHaveLength(9);
    expect(panel('id', true)).toContain('<span>Estimasi posisi</span>');
  });

  it('names the heading in the legend only while the map draws it', () => {
    const scale: DbScale = { minDb: -60, maxDb: 0, thresholdDb: -60, mode: 'auto', known: false };
    const legend = (heading: 'live' | 'held' | null, lang: Lang = 'en') => markup(<OverlayLegend settings={DEFAULT_DOA_OVERLAY_SETTINGS} scale={scale} saturation={0} ringStepM={250} halfPower={null} heading={heading} />, lang);
    expect(legend('live')).toContain('legend-swatch legend-heading"></i> RDF-SDR heading');
    expect(legend('held')).toContain('legend-heading is-held"></i> RDF-SDR heading · STALE');
    expect(legend('held', 'id')).toContain('Heading RDF-SDR · USANG');
    expect(legend(null)).not.toContain('legend-heading');
  });
});
