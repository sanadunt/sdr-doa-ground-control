import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { estimatePositionText, estimateSourceKey, formatEstimateDistance, positionEstimate, positionEstimateFeatures, positionEstimateLabel, positionEstimateLineLabels } from './positionEstimate';
import { bearingAndDistance } from './doaGeometry';
import { EstimatePanel } from '../components/overview/EstimatePanel';
import { I18nContext, translate } from './i18n';
import { DEFAULT_DOA_OVERLAY_SETTINGS } from './doaGeometry';
import { validateOverlaySettings } from './mapOverlaySettings';
import { DEFAULT_COMPASS_CONFIG, geographicBearingForBin, nodeArrayHeading, resolveCompassSource } from './polar';
import type { Translate } from './i18n';

const ESTIMATE = {
  state: 'ESTIMATE', latitude: -6.902, longitude: 107.62, radius_m: 420, distance_m: 3400, bearing_deg: 294.3,
  samples: 250, stations: 101, spread_deg: 70.3, frequency_hz: 433_000_000, reset_reason: null,
  method: { min_stations: 3, min_spread_deg: 15 },
  grid: { cells: 100, cell_m: 100, south: -6.95, west: 107.6, north: -6.86, east: 107.69, hot: [[50, 50, 1], [51, 50, 0.6], [999, 0, 1], [1, 2, 7]] },
};

const t: Translate = ((key: string) => (key === 'estimate.mapLabel' ? 'ESTIMATE' : key)) as Translate;

function snapshot(estimate: unknown, extra: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return { position_estimate: estimate as Record<string, unknown>, ...extra } as TelemetrySnapshot;
}

describe('positionEstimate', () => {
  it('reads the estimate and drops bad cells', () => {
    const estimate = positionEstimate(snapshot(ESTIMATE));
    expect(estimate?.state).toBe('ESTIMATE');
    expect([estimate?.latitude, estimate?.longitude, estimate?.distanceM, estimate?.stations]).toEqual([-6.902, 107.62, 3400, 101]);
    expect(estimate?.grid?.hot).toEqual([[50, 50, 1], [51, 50, 0.6]]);
  });

  it('is null without one and in simulation', () => {
    expect(positionEstimate(snapshot(undefined))).toBeNull();
    expect(positionEstimate(snapshot(null))).toBeNull();
    expect(positionEstimate(snapshot(ESTIMATE, { simulation: true }))).toBeNull();
  });

  it('never claims a position without coordinates', () => {
    expect(positionEstimate(snapshot({ ...ESTIMATE, latitude: null }))?.state).toBe('NO_DATA');
    expect(positionEstimate(snapshot({ ...ESTIMATE, state: 'SOMETHING' }))?.state).toBe('NO_DATA');
  });

  it('draws cells, radius, link and point for an ESTIMATE', () => {
    const estimate = positionEstimate(snapshot(ESTIMATE));
    const shapes = positionEstimateFeatures(estimate, { latitude: -6.93, longitude: 107.71 });
    expect(shapes.heat.features).toHaveLength(2);
    expect(shapes.heat.features[0].properties).toEqual({ share: 1, ready: true });
    expect(shapes.lines.features.map((feature) => feature.properties?.kind)).toEqual(['radius', 'link']);
    expect(shapes.point.features[0].geometry.coordinates).toEqual([107.62, -6.902]);
    // Cell 50,50 of a 100-cell grid starts half-way.
    const ring = shapes.heat.features[0].geometry.coordinates[0];
    expect(ring[0][0]).toBeCloseTo(107.645, 6);
    expect(ring[0][1]).toBeCloseTo(-6.905, 6);
  });

  it('draws only the faint cells while the bearings do not cross', () => {
    const estimate = positionEstimate(snapshot({ ...ESTIMATE, state: 'NEED_MOVEMENT' }));
    const shapes = positionEstimateFeatures(estimate, { latitude: -6.93, longitude: 107.71 });
    expect(shapes.heat.features[0].properties?.ready).toBe(false);
    expect(shapes.point.features).toHaveLength(0);
    expect(shapes.lines.features).toHaveLength(0);
  });

  it('labels the point and formats distances', () => {
    const estimate = positionEstimate(snapshot(ESTIMATE));
    expect(estimate && positionEstimateLabel(estimate, t)).toBe('ESTIMATE');
    expect(formatEstimateDistance(850)).toBe('850 m');
    expect(formatEstimateDistance(12_400)).toBe('12 km');
    expect(formatEstimateDistance(null)).toBe('--');
  });

  it('reads the groundstation distance and the sources, and draws the line from the groundstation', () => {
    const value = { ...ESTIMATE, ground_latitude: -6.92, ground_longitude: 107.6, ground_distance_m: 5200, ground_bearing_deg: 47.6,
      bearing_source: 'drone', position_source: 'drone' };
    const estimate = positionEstimate(snapshot(value));
    expect([estimate?.groundDistanceM, estimate?.groundBearingDeg, estimate?.bearingSource, estimate?.positionSource])
      .toEqual([5200, 47.6, 'drone', 'drone']);
    const shapes = positionEstimateFeatures(estimate, { latitude: -6.93, longitude: 107.71 });
    expect(shapes.lines.features.map((feature) => feature.properties?.kind)).toEqual(['radius', 'link', 'ground']);
    expect(shapes.lines.features[2].geometry.coordinates).toEqual([[107.6, -6.92], [107.62, -6.902]]);
    const named: Translate = ((key: string, values?: Record<string, string>) => (
      key === 'estimate.mapNode' ? `RDF-SDR ${values?.distance} · ${values?.bearing}°`
        : key === 'estimate.mapGround' ? `GS ${values?.distance} · ${values?.bearing}°` : key)) as Translate;
    const station = { latitude: -6.93, longitude: 107.71 };
    const labels = positionEstimateLineLabels(estimate, station, named);
    // Measured from the points drawn, written halfway along each line.
    const fromStation = bearingAndDistance(station, 107.62, -6.902);
    const fromGround = bearingAndDistance({ latitude: -6.92, longitude: 107.6 }, 107.62, -6.902);
    expect(labels.map((label) => label.text)).toEqual([
      `RDF-SDR ${formatEstimateDistance(fromStation.distanceM)} · ${Math.round(fromStation.bearingDeg)}°`,
      `GS ${formatEstimateDistance(fromGround.distanceM)} · ${Math.round(fromGround.bearingDeg)}°`,
    ]);
    expect(labels[1].lngLat[0]).toBeCloseTo(107.61, 3);
    expect(labels[1].lngLat[1]).toBeCloseTo(-6.911, 3);
    expect(positionEstimateLineLabels(positionEstimate(snapshot({ ...ESTIMATE, state: 'NEED_MOVEMENT' })), station, named)).toEqual([]);
    expect(positionEstimateLineLabels(estimate, null, named).map((label) => label.text[0])).toEqual(['G']);
    expect(estimate && estimateSourceKey(estimate)).toBe('estimate.sourceDrone');
    // An older console, or a groundstation without a fix: no line, no source line.
    const plain = positionEstimate(snapshot({ ...ESTIMATE, bearing_source: 'compass' }));
    expect([plain?.groundDistanceM, plain?.bearingSource]).toEqual([null, null]);
    expect(plain && estimateSourceKey(plain)).toBeNull();
    expect(positionEstimateFeatures(plain, null).lines.features.map((feature) => feature.properties?.kind)).toEqual(['radius']);
    for (const [bearing, position, key] of [['drone', 'rdf', 'estimate.sourceDroneYaw'], ['rdf', 'drone', 'estimate.sourceDroneGps'], ['rdf', 'rdf', 'estimate.sourceRdf']]) {
      const mixed = positionEstimate(snapshot({ ...ESTIMATE, bearing_source: bearing, position_source: position }));
      expect(mixed && estimateSourceKey(mixed)).toBe(key);
    }
  });

  it('shows both distances and the source on the card', () => {
    const estimate = positionEstimate(snapshot({ ...ESTIMATE, ground_latitude: -6.92, ground_longitude: 107.6, ground_distance_m: 5200,
      ground_bearing_deg: 47.6, bearing_source: 'drone', position_source: 'drone' }));
    if (!estimate) throw new Error('no estimate');
    const html = renderToStaticMarkup(createElement(I18nContext.Provider, { value: { lang: 'id', setLang: () => undefined, t: (key, vars) => translate('id', key, vars) } }, createElement(EstimatePanel, { estimate })));
    expect(html).toContain('3.4 km dari RDF-SDR · arah 294°');
    expect(html).toContain('5.2 km dari groundstation · arah 48°');
    expect(html).toContain('Bearing terakhir: GPS dan yaw drone');
  });
});

describe('node array heading as the compass offset (contract 1.10)', () => {
  const live = (heading: unknown): TelemetrySnapshot => ({
    source: { kind: 'mqtt' },
    doa_candidates: { mqtt: { available: true, canonical_angle_deg: 150, array_heading_deg: heading } },
  } as unknown as TelemetrySnapshot);

  it('turns theta_0 into the bearing the edge sent', () => {
    const resolution = resolveCompassSource(live(84.3), undefined, DEFAULT_COMPASS_CONFIG);
    expect(resolution.code).toBe('NODE_HEADING');
    expect(resolution.offsetVerified).toBe(true);
    // theta_0 150 (counter-clockwise) with the array reference at 84.3: b = 84.3 - 150 = 294.3.
    expect(geographicBearingForBin(150, resolution.settings.compassOffset)).toBeCloseTo(294.3, 6);
  });

  it('leaves a manual offset alone and ignores a missing heading', () => {
    const manual = resolveCompassSource(live(84.3), undefined, { ...DEFAULT_COMPASS_CONFIG, source: 'MANUAL', manualCompassOffset: 12 });
    expect([manual.code, manual.settings.compassOffset]).toEqual(['MANUAL', 12]);
    expect(nodeArrayHeading(live(null))).toBeNull();
    expect(nodeArrayHeading(live(Number.NaN))).toBeNull();
    expect(resolveCompassSource(live(null), undefined, DEFAULT_COMPASS_CONFIG).code).not.toBe('NODE_HEADING');
  });
});

describe('the estimate in land map coordinates', () => {
  const tId: Translate = ((key, vars) => translate('id', key, vars)) as Translate;
  const withGround = positionEstimate(snapshot({ ...ESTIMATE, ground_latitude: -6.92, ground_longitude: 107.6 }));
  const withoutGround = positionEstimate(snapshot(ESTIMATE));
  if (!withGround || !withoutGround) throw new Error('no estimate');

  it('writes Lat/Lon, UTM, MGRS and X,Y from the groundstation', () => {
    // UTM and MGRS of -6.902, 107.62 by pyproj and the mgrs package: 48M 789540 9236289, 48MYT8954036288.
    expect(estimatePositionText(withGround, 'latlon', tId)).toBe('-6.90200, 107.62000 · ±420 m');
    expect(estimatePositionText(withGround, 'utm', tId)).toBe('UTM 48M · X 789540 · Y 9236289 · ±420 m');
    expect(estimatePositionText(withGround, 'mgrs', tId)).toBe('MGRS 48M YT 89540 36288 · ±420 m');
    expect(estimatePositionText(withGround, 'gsxy', tId)).toBe('Dari GS · X +2210 m · Y +1991 m · ±420 m');
  });

  it('says when X,Y from GS has no groundstation fix', () => {
    expect(estimatePositionText(withoutGround, 'gsxy', tId)).toBe('X,Y dari GS: GPS groundstation belum fix');
  });

  it('keeps the choice in the overlay settings, Lat/Lon for an older or unknown value', () => {
    expect(DEFAULT_DOA_OVERLAY_SETTINGS.coordinateFormat).toBe('latlon');
    expect(validateOverlaySettings({ coordinateFormat: 'mgrs' }).coordinateFormat).toBe('mgrs');
    expect(validateOverlaySettings({ coordinateFormat: 'xyz' as never }).coordinateFormat).toBe('latlon');
    expect(validateOverlaySettings({}).coordinateFormat).toBe('latlon');
  });

  it('shows the chosen format with a 44 px select on the card', () => {
    const html = renderToStaticMarkup(createElement(I18nContext.Provider, { value: { lang: 'id', setLang: () => undefined, t: (key, vars) => translate('id', key, vars) } },
      createElement(EstimatePanel, { estimate: withGround, coordinateFormat: 'utm', onCoordinateFormatChange: () => undefined })));
    expect(html).toContain('UTM 48M · X 789540 · Y 9236289 · ±420 m');
    expect(html).toMatch(/<label class="ov-estimate-format"><span>Koordinat<\/span><select>/);
    for (const label of ['Lat/Lon', 'UTM', 'MGRS', 'X,Y dari GS']) expect(html).toContain(`>${label}</option>`);
    expect(html).toContain('<option value="utm" selected="">UTM</option>');
    // Without a handler (a test or an older caller) the card shows no select.
    const plain = renderToStaticMarkup(createElement(I18nContext.Provider, { value: { lang: 'id', setLang: () => undefined, t: (key, vars) => translate('id', key, vars) } },
      createElement(EstimatePanel, { estimate: withGround })));
    expect(plain).not.toContain('ov-estimate-format');
  });
});

describe('the estimate card in a short left column', () => {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const css = process.getBuiltinModule('node:fs').readFileSync(new URL('../overview-dashboard.css', import.meta.url), 'utf8');

  it('scrolls instead of shrinking its lines to nothing', () => {
    // The lines with overflow: hidden (position, bearings, source) shrank to 0 px while the HUD and the card did not fit
    // the left column (1600 x 700); the card scrolls instead.
    expect(css).toMatch(/\.ov-estimate > \* \{ flex: none; \}/);
    expect(css).toMatch(/\.ov-estimate \{[^}]*overflow-y: auto;/);
  });

  it('wraps the position, so a long UTM or MGRS value is never cut', () => {
    expect(css).toMatch(/\.ov-estimate \.ov-estimate-position \{ white-space: normal; overflow-wrap: anywhere; \}/);
  });
});
