import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeCard, navRows } from '../components/overview/NodeCard';
import type { TelemetrySnapshot } from '../types';
import { doaStatusTextKey, overviewDoaStatus, provisionalTheta } from './doaStatus';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { gpsReportsNoFix, holdStationCoordinate, resolveGpsSource, resolveStationCoordinate } from './map';
import { overLora, snapshotNav, sourceBadge } from './telemetrySource';
import { rdfHeading } from './rdfHeading';

/** An answer of tools/telemetry_source.py, written by tools/test_telemetry_source.py. */
function answer(name: string): TelemetrySnapshot {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/telemetry-source/${name}`, import.meta.url), 'utf8')) as TelemetrySnapshot;
}

// An MQTT answer over the LoRa serial link: no Data Out, the position from the health nav fields.
const LORA = answer('mqtt-lora-nav.json');
const LIVE = answer('mqtt-live.json');

function withNav(base: TelemetrySnapshot, nav: Record<string, unknown> | null): TelemetrySnapshot {
  return { ...base, nav };
}

function node(snapshot: TelemetrySnapshot, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <NodeCard snapshot={snapshot} localSnapshotFresh coordinate={resolveStationCoordinate(snapshot)} positionHeld={false} compassOffset={0} offsetSource="DATA_OUT" offsetManual={false} collapsed={false} onToggle={() => undefined} />
    </I18nContext.Provider>,
  );
}

describe('LoRa link of an MQTT answer', () => {
  it('is named only over the LoRa serial bridge', () => {
    expect(overLora(LORA)).toBe(true);
    expect(overLora(LIVE)).toBe(false);
    expect(overLora(null)).toBe(false);
    expect(snapshotNav(LIVE)).toBeNull();
    expect(snapshotNav(LORA)).toMatchObject({ gps_state: 'FIX', fix: 3, latitude: -6.20576, longitude: 106.81 });
  });

  it('shows the unknown ADC overdrive as not available over LoRa, the bearing still drawn', () => {
    const status = overviewDoaStatus(LORA, true);
    expect(status).toMatchObject({ code: 'DEGRADED', reason: 'adcNotOverLora', shown: true });
    expect(translate('id', 'polar.adcNotOverLora')).toContain('tidak dilaporkan lewat Telemetry LoRa');
    expect(overviewDoaStatus(withNav({ ...LORA, source: { ...LORA.source, link: null } }, LORA.nav ?? null), true).reason).toBe('adcUnknown');
  });

  it('names the source and the missing DoA Telemetry LoRa', () => {
    expect(sourceBadge(LORA)).toMatchObject({ kind: 'mqtt', labelKey: 'source.lora' });
    expect(sourceBadge(LIVE)).toMatchObject({ kind: 'mqtt', labelKey: 'source.mqtt' });
    expect(translate('en', 'source.lora')).toBe('Telemetry LoRa');
    const noDoa = { ...LORA, doa_candidates: { mqtt: { available: false } } } as TelemetrySnapshot;
    expect(overviewDoaStatus(noDoa, true)).toMatchObject({ code: 'STALE', reason: 'loraNoDoa' });
    expect(doaStatusTextKey('loraNoDoa')).toBe('polar.loraNoDoa');
    expect(translate('id', 'polar.loraNoDoa')).toBe('Tidak ada DoA LIVE lewat Telemetry LoRa');
    const mqttNoDoa = { ...LIVE, doa_candidates: { mqtt: { available: false } } } as TelemetrySnapshot;
    expect(overviewDoaStatus(mqttNoDoa, true).reason).toBe('mqttNoDoa');
  });

  it('names the node values that cannot come over LoRa instead of faking them', () => {
    const markup = node(LORA);
    expect(markup).toContain('Frequency and gain not available over Telemetry LoRa');
    expect(markup.match(/not available over Telemetry LoRa/g)?.length).toBeGreaterThanOrEqual(4);
    expect(node(LORA, 'id')).toContain('tidak tersedia lewat Telemetry LoRa');
    expect(node(LIVE)).not.toContain('Telemetry LoRa');
  });
});

describe('Station position from the health nav fields', () => {
  it('is used when no light Data Out read gives one', () => {
    expect(resolveStationCoordinate(LORA)).toEqual({ latitude: -6.20576, longitude: 106.81, source: 'NAV' });
    expect(resolveGpsSource(LORA).coordinate).toEqual({ latitude: -6.20576, longitude: 106.81, source: 'DATA_OUT' });
    expect(gpsReportsNoFix(LORA, true)).toBe(false);
  });

  it('keeps doa.xml of the light read first', () => {
    const both = withNav(LIVE, { gps_state: 'FIX', fix: 3, latitude: 1, longitude: 2 });
    expect(resolveStationCoordinate(both)).toEqual(resolveStationCoordinate(LIVE));
  });

  it('needs a GPS fix and a real coordinate', () => {
    for (const nav of [
      { gps_state: 'NO_FIX', fix: 0 },
      { gps_state: 'FIX', fix: 0, latitude: -6.2, longitude: 106.8 },
      { gps_state: 'FIX', fix: 3, latitude: 0, longitude: 0 },
      { gps_state: 'FIX', fix: 3, latitude: 91, longitude: 106.8 },
      { hs: 'OK', heading_deg: 10 },
    ]) {
      expect(resolveStationCoordinate(withNav(LORA, nav))).toBeNull();
    }
    expect(gpsReportsNoFix(withNav(LORA, { gps_state: 'NO_FIX', fix: 0 }), true)).toBe(true);
    expect(gpsReportsNoFix(withNav(LORA, { compass_state: 'OK' }), true)).toBe(false);
    expect(gpsReportsNoFix(withNav(LORA, null), true)).toBe(false);
  });
});

describe('Compass and GPS rows of the node card', () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('en', key, vars);

  it('shows the RDF-SDR compass, GPS, altitude and speed', () => {
    expect(navRows(snapshotNav(LORA), t)).toEqual([
      ['Compass', '201.1°', 'is-good'],
      ['GPS', 'FIX 3D · 7 sat', 'is-good'],
      ['Altitude', '715.9 m'],
      ['Speed', '0.1 m/s'],
    ]);
    expect(node(LORA)).toContain('201.1°');
    expect(node(LORA, 'id')).toContain('Kompas');
  });

  it('names a compass or GPS that is not ready and shows nothing without nav', () => {
    expect(navRows({ compass_state: 'NO_REPLY', heading_deg: null, gps_state: 'NO_FIX', fix: 0, satellites: 2 }, t)).toEqual([
      ['Compass', 'NO_REPLY', 'is-warn'],
      ['GPS', 'NO_FIX · 2 sat', 'is-warn'],
    ]);
    expect(navRows({ compass_state: '<b>', gps_state: 'fix ok' }, t)).toEqual([]);
    expect(navRows(null, t)).toEqual([]);
    expect(node(LIVE)).not.toContain('<dt>Compass</dt>');
  });
});

// 3 November: a retune left the KrakenSDR DAQ unsynced while health, compass and GPS kept coming over LoRa.
const UNSYNCED = answer('mqtt-lora-daq-unhealthy.json');

describe('an MQTT answer while the DAQ is not healthy', () => {
  it('keeps the RDF-SDR on the map: position, compass heading and node card', () => {
    expect(snapshotNav(UNSYNCED)).toMatchObject({ heading_deg: 201.1, compass_state: 'OK', gps_state: 'FIX', latitude: -6.20576 });
    expect(rdfHeading(UNSYNCED, true)).toEqual({ headingDeg: 201.1, state: 'OK', compassState: 'OK' });
    expect(resolveStationCoordinate(UNSYNCED)).toMatchObject({ latitude: -6.20576, longitude: 106.81 });
    expect(node(UNSYNCED)).toContain('201');
  });

  it('says the DAQ did not sync instead of showing no RDF-SDR at all', () => {
    expect(overviewDoaStatus(UNSYNCED, true)).toMatchObject({ code: 'DEGRADED', shown: false, reason: 'daqDegraded' });
    const badge = sourceBadge(UNSYNCED);
    expect(badge).toMatchObject({ kind: 'mqtt', labelKey: 'source.lora', tone: 'warn', reasons: ['MQTT_DAQ_NOT_HEALTHY'] });
    expect(sourceBadge(LORA)).toMatchObject({ tone: 'good', reasons: [] });
    expect(translate('id', 'source.reason.MQTT_DAQ_NOT_HEALTHY')).toBe('DAQ tidak sehat menurut MQTT');
  });
});

// link_mode "lora": nothing over the radio for 2 minutes. The last health and DoA stay, each with its age.
const QUIET = answer('mqtt-lora-held-health.json');

describe('a held answer of link_mode lora', () => {
  it('keeps the compass heading and the position, both STALE', () => {
    expect(snapshotNav(QUIET)).toMatchObject({ stale: true, age_ms: 120_000, heading_deg: 201.1 });
    expect(rdfHeading(QUIET, true)).toEqual({ headingDeg: 201.1, state: 'STALE', compassState: 'OK' });
    const coordinate = resolveStationCoordinate(QUIET);
    expect(coordinate).toMatchObject({ latitude: -6.20576, longitude: 106.81, source: 'NAV', stale: true });
    expect(holdStationCoordinate(null, coordinate, false)).toMatchObject({ held: true });
    expect(holdStationCoordinate(null, resolveStationCoordinate(LORA), false)).toMatchObject({ held: false });
  });

  it('holds the last DoA, never as a valid one, and names why on the source chip', () => {
    const status = overviewDoaStatus(QUIET, true);
    expect(status.shown).toBe(false);
    expect(provisionalTheta(QUIET, status)).toBe(160);
    expect(sourceBadge(QUIET)).toMatchObject({ labelKey: 'source.lora', tone: 'warn', reasons: ['MQTT_HEALTH_STALE'] });
  });
});
