import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GroundGpsView, MapCoordinate, TelemetrySnapshot } from '../types';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { destination } from './doaGeometry';
import { resolveGpsSource } from './map';
import {
  distanceAndBearing,
  groundGpsCurrent,
  groundGpsCause,
  groundGpsCode,
  groundGpsState,
  groundGpsSummary,
  groundGpsTone,
  groundLink,
  groundLinkLabel,
  groundPosition,
  normalizeGroundGps,
  snapshotGroundGps,
  stationPositionLive,
} from './groundGps';
import { NodeCard } from '../components/overview/NodeCard';
import { GroundGpsCard } from '../pages/SystemHealthPage';

/** An answer of tools/telemetry_source.py over Telemetry LoRa, written by tools/test_telemetry_source.py. */
function answer(name: string): TelemetrySnapshot {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/telemetry-source/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text) as TelemetrySnapshot;
}

const t = (lang: Lang) => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(lang, key, vars);

const loraAnswer = answer('mqtt-lora-rf.json');
const station = resolveGpsSource(loraAnswer).coordinate as MapCoordinate;
// 1234 m south-west of the RDF-SDR, so the RDF-SDR lies about 45° from the groundstation.
const [groundLon, groundLat] = destination(station, 225, 1234);

/** The ground_gps block of tools/ground_gps.py's view, per the contract. */
function view(overrides: Partial<GroundGpsView> = {}): GroundGpsView {
  return {
    present: true,
    state: 'FIX',
    lat: groundLat,
    lon: groundLon,
    alt: 697.6,
    fix: 3,
    sat: 4,
    hdop: 1.9,
    sog: 0.288,
    cog: null,
    device: 'usb-u-blox_AG_-_www.u-blox.com_u-blox_7_-_GPS_GNSS_Receiver-if00',
    error: null,
    status_age_ms: 800,
    received_at_ms: 1_793_070_140_000,
    stale_after_ms: 10_000,
    ...overrides,
  };
}

function withGround(block: unknown): TelemetrySnapshot {
  return { ...loraAnswer, ground_gps: block as GroundGpsView | null };
}

describe('normalizeGroundGps', () => {
  it('reads the view and refuses only a non-object', () => {
    expect(normalizeGroundGps(view())).toEqual(view());
    for (const value of [null, undefined, 'FIX', 3, []]) expect(normalizeGroundGps(value)).toBeNull();
  });

  it('drops a bad field, never the status', () => {
    const read = normalizeGroundGps({ ...view(), sat: -1, fix: 1, hdop: 'x', alt: Number.NaN, cog: 400, device: '   ', error: 7, stale_after_ms: 0 });
    expect(read).toMatchObject({ state: 'FIX', lat: groundLat, sat: null, fix: null, hdop: null, alt: null, cog: null, device: null, error: null, stale_after_ms: 10_000 });
  });

  it('keeps lat and lon only while FIX and in range', () => {
    expect(normalizeGroundGps(view({ state: 'NO_FIX' }))).toMatchObject({ lat: null, lon: null });
    expect(normalizeGroundGps({ ...view(), lat: 91 })).toMatchObject({ lat: null, lon: groundLon });
  });

  it('reads an unknown state or a status nobody reported as NONE', () => {
    expect(normalizeGroundGps({ ...view(), state: 'WARMING_UP' })?.state).toBe('NONE');
    expect(normalizeGroundGps({ ...view(), present: false })?.state).toBe('NONE');
  });
});

describe('groundPosition', () => {
  it('comes from a FIX of the answer', () => {
    expect(groundPosition(withGround(view()))).toEqual({ latitude: groundLat, longitude: groundLon, altitude: 697.6, state: 'FIX' });
  });

  it('is null without a current FIX', () => {
    expect(groundPosition(loraAnswer)).toBeNull();
    expect(groundPosition(withGround(null))).toBeNull();
    expect(groundPosition(null)).toBeNull();
    for (const state of ['NO_FIX', 'NO_DEVICE', 'NO_DATA', 'ERROR', 'STOPPED', 'STALE', 'NONE'] as const) {
      expect(groundPosition(withGround(view({ state })))).toBeNull();
    }
    expect(groundPosition(withGround(view({ status_age_ms: 10_001 })))).toBeNull();
    expect(groundPosition(withGround(view({ lat: null })))).toBeNull();
  });
});

describe('distance and bearing', () => {
  it('is geodesic, from the groundstation to the RDF-SDR', () => {
    const { distanceM, bearingDeg } = distanceAndBearing({ latitude: groundLat, longitude: groundLon }, station);
    expect(distanceM).toBeCloseTo(1234, 0);
    expect(bearingDeg).toBeGreaterThan(44.9);
    expect(bearingDeg).toBeLessThan(45.1);
    // The live sample of 2026-11-02 against the RDF-SDR of the fixture: about 125 km.
    const far = distanceAndBearing({ latitude: -6.9299005, longitude: 107.7115572 }, { latitude: -6.20576, longitude: 106.81 });
    expect(far.distanceM / 1000).toBeGreaterThan(120);
    expect(far.distanceM / 1000).toBeLessThan(130);
    expect(far.bearingDeg).toBeGreaterThan(300);
    expect(far.bearingDeg).toBeLessThan(320);
  });

  it('names a live line by its distance and bearing, a reference one as such', () => {
    const live = groundLink({ latitude: groundLat, longitude: groundLon }, station, true);
    expect(live && groundLinkLabel(live, t('en'))).toBe('1.23 km · 45.0°');
    const reference = groundLink({ latitude: groundLat, longitude: groundLon }, station, false);
    expect(reference && groundLinkLabel(reference, t('en'))).toBe('REFERENCE · 1.23 km · 45.0°');
    expect(reference && groundLinkLabel(reference, t('id'))).toBe('REFERENSI · 1.23 km · 45.0°');
    const [nearLon, nearLat] = destination(station, 180, 850);
    const near = groundLink({ latitude: nearLat, longitude: nearLon }, station, true);
    expect(near && groundLinkLabel(near, t('en'))).toBe('850 m · 0.0°');
  });

  it('draws the line from the groundstation to the RDF-SDR along the great circle', () => {
    const near = groundLink({ latitude: groundLat, longitude: groundLon }, station, true);
    const line = near?.features.features[0];
    expect(line?.properties).toMatchObject({ layer: 'ground-link', live: true });
    expect(line?.geometry.coordinates).toEqual([[groundLon, groundLat], [station.longitude, station.latitude]]);
    const far = groundLink({ latitude: -6.9299005, longitude: 107.7115572 }, { latitude: -6.20576, longitude: 106.81 }, false);
    const coordinates = far?.features.features[0].geometry.coordinates ?? [];
    expect(coordinates.length).toBe(33);
    expect(coordinates[coordinates.length - 1]).toEqual([106.81, -6.20576]);
    const half = distanceAndBearing({ latitude: -6.9299005, longitude: 107.7115572 }, { latitude: far!.label[1], longitude: far!.label[0] });
    expect(half.distanceM).toBeCloseTo(far!.distanceM / 2, 0);
    expect(groundLink(station, station, true)).toBeNull();
  });

  it('counts only a live RDF-SDR position as live', () => {
    expect(stationPositionLive(station, false)).toBe(true);
    expect(stationPositionLive(station, true)).toBe(false);
    for (const source of ['FALLBACK', 'MANUAL', 'SIMULATION'] as const) expect(stationPositionLive({ ...station, source }, false)).toBe(false);
    expect(stationPositionLive(null, false)).toBe(false);
  });
});

describe('state and text', () => {
  it('turns a status of an old answer STALE', () => {
    expect(groundGpsState(view(), true)).toBe('FIX');
    expect(groundGpsState(view(), false)).toBe('STALE');
    expect(groundGpsState(view({ state: 'NONE' }), false)).toBe('NONE');
    expect(groundGpsState(null, true)).toBe('NONE');
  });

  it('shows codes with spaces and tones by what the operator must do', () => {
    expect(groundGpsCode('NO_DEVICE')).toBe('NO DEVICE');
    expect(groundGpsTone('FIX')).toBe('good');
    expect(groundGpsTone('NO_DEVICE')).toBe('bad');
    expect(groundGpsTone('NO_FIX')).toBe('warn');
    expect(groundGpsTone('NONE')).toBe('neutral');
  });

  it('summarises the fix with the distance to the RDF-SDR', () => {
    expect(groundGpsSummary(view(), 'FIX', { distanceM: 1234, live: true }, t('en'))).toBe('FIX 3D · 4 sat · 1.23 km');
    expect(groundGpsSummary(view(), 'FIX', { distanceM: 1234, live: false }, t('id'))).toBe('FIX 3D · 4 sat · 1.23 km (referensi)');
    expect(groundGpsSummary(view({ fix: null, sat: null }), 'FIX', null, t('en'))).toBe('FIX');
    expect(groundGpsSummary(view({ state: 'NO_FIX' }), 'NO_FIX', null, t('en'))).toBe('NO FIX');
  });

  it('names every cause in both languages', () => {
    for (const lang of ['en', 'id'] as const) {
      for (const state of ['NO_FIX', 'NO_DEVICE', 'NO_DATA', 'ERROR', 'STOPPED', 'STALE', 'NONE'] as const) {
        const text = groundGpsCause(view({ state, error: 'open failed' }), state, t(lang));
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/[{}]/u);
      }
      expect(groundGpsCause(null, 'NONE', t(lang))).toMatch(/MQTT/u);
    }
    expect(groundGpsCause(view({ state: 'ERROR', error: 'open failed' }), 'ERROR', t('en'))).toContain('open failed');
    expect(groundGpsCause(view(), 'FIX', t('en'))).toBeNull();
  });
});

function nodeCard(snapshot: TelemetrySnapshot, options: { fresh?: boolean; held?: boolean; coordinate?: MapCoordinate | null; lang?: Lang } = {}): string {
  const lang = options.lang ?? 'en';
  const position = groundPosition(snapshot);
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: t(lang) }}>
      <NodeCard
        snapshot={snapshot}
        localSnapshotFresh={options.fresh ?? true}
        coordinate={options.coordinate === undefined ? station : options.coordinate}
        positionHeld={options.held ?? false}
        ground={options.fresh === false || !position ? null : position}
        compassOffset={0}
        offsetSource="DATA_OUT"
        offsetManual={false}
        collapsed={false}
        onToggle={() => undefined}
      />
    </I18nContext.Provider>,
  );
}

function groundRowText(markup: string): string | null {
  const match = /<dt>Groundstation<\/dt><dd(?: class="([^"]*)")?>([^<]*)<\/dd>/u.exec(markup);
  return match ? `${match[2]}${match[1] ? ` [${match[1]}]` : ''}` : null;
}

describe('NodeCard Groundstation row', () => {
  it('shows the fix and the distance to the RDF-SDR', () => {
    expect(groundRowText(nodeCard(withGround(view())))).toBe('FIX 3D · 4 sat · 1.23 km [is-good]');
  });

  it('names the distance a reference while the RDF-SDR position is not live', () => {
    expect(groundRowText(nodeCard(withGround(view()), { held: true }))).toBe('FIX 3D · 4 sat · 1.23 km (reference) [is-good]');
    expect(groundRowText(nodeCard(withGround(view()), { coordinate: { ...station, source: 'FALLBACK' } }))).toBe('FIX 3D · 4 sat · 1.23 km (reference) [is-good]');
  });

  it('shows the state without a fix, STALE for an old answer', () => {
    expect(groundRowText(nodeCard(withGround(view({ state: 'NO_DEVICE', lat: null, lon: null }))))).toBe('NO DEVICE [is-bad]');
    expect(groundRowText(nodeCard(withGround(view({ state: 'NO_FIX', lat: null, lon: null }))))).toBe('NO FIX');
    expect(groundRowText(nodeCard(withGround(view()), { fresh: false }))).toBe('STALE');
  });

  it('has no row without a ground GPS status', () => {
    expect(groundRowText(nodeCard(loraAnswer))).toBeNull();
    expect(groundRowText(nodeCard(withGround(null)))).toBeNull();
    expect(groundRowText(nodeCard(withGround({ ...view(), present: false, state: 'NONE' })))).toBeNull();
  });
});

function healthCard(snapshot: TelemetrySnapshot | null, lang: Lang = 'en', fresh = true): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: t(lang) }}>
      <GroundGpsCard snapshot={snapshot} localSnapshotFresh={fresh} />
    </I18nContext.Provider>,
  );
}

describe('System Health Groundstation GPS card', () => {
  it('shows the fix', () => {
    const markup = healthCard(withGround(view()));
    expect(markup).toContain('Groundstation GPS');
    expect(markup).toContain('tone-good">FIX<');
    expect(markup).toContain(`${groundLat.toFixed(6)}°, ${groundLon.toFixed(6)}°`);
    expect(markup).toContain('697.6 m');
    expect(markup).toContain('4 · FIX 3D');
    expect(markup).toContain('1.90');
    expect(markup).toContain('u-blox_7');
    expect(markup).not.toContain('role="alert"');
  });

  it('names why there is no position', () => {
    const markup = healthCard(withGround(view({ state: 'NO_DEVICE', lat: null, lon: null })), 'id');
    expect(markup).toContain('GPS groundstation');
    expect(markup).toContain('tone-bad">NO DEVICE<');
    expect(markup).toContain('tidak tercolok');
    expect(healthCard(withGround(null))).toContain('MQTT monitor is off');
    expect(healthCard(withGround(view()), 'en', false)).toContain('>STALE<');
  });

  it('is left out by a console without ground GPS', () => {
    expect(healthCard(loraAnswer)).toBe('');
    expect(healthCard(null)).toBe('');
  });

  it('reads the server block through one normalizer', () => {
    expect(snapshotGroundGps(withGround(view()))).toEqual(view());
  });
});

describe('groundstation GPS freshness', () => {
  it('ages by its own status, apart from the RDF-SDR data', () => {
    // The RDF-SDR is off (answer none over LoRa) while the groundstation GPS still reports.
    const none = { ...withGround(view({ status_age_ms: 1_000 })), status: { available: false } } as TelemetrySnapshot;
    expect(groundGpsCurrent(none, 100_000, false, 100_000 + 8_000)).toBe(true);
    expect(groundGpsCurrent(none, 100_000, false, 100_000 + 9_001)).toBe(false);
    expect(groundGpsCurrent(none, 100_000, true, 100_000)).toBe(false);
    expect(groundGpsCurrent(none, null, false, 100_000)).toBe(false);
    expect(groundGpsCurrent(withGround(null), 100_000, false, 100_000)).toBe(false);
    // The GS row stays a FIX on a card whose RDF-SDR data has expired.
    const card = renderToStaticMarkup(
      <I18nContext.Provider value={{ lang: 'en', setLang: () => undefined, t: t('en') }}>
        <NodeCard snapshot={none} localSnapshotFresh={false} groundGpsFresh coordinate={station} positionHeld={false}
          ground={groundPosition(none)} compassOffset={0} offsetSource="DATA_OUT" offsetManual={false} collapsed={false} onToggle={() => undefined} />
      </I18nContext.Provider>,
    );
    expect(groundRowText(card)).toMatch(/^FIX/);
  });
});
