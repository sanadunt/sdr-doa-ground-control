import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TelemetrySnapshot } from '../types';
import { I18nContext, gateReasonLabel, translate } from './i18n';
import type { Lang } from './i18n';
import { actionableGateReasons, overviewDoaStatus } from './doaStatus';
import { candidateErrors, deriveDataState, nativeViewsReady, polarDataReady, primaryCandidate, sourceViewNames } from './telemetry';
import { gpsReportsNoFix, holdStationCoordinate, resolveGpsSource, resolveStationCoordinate } from './map';
import { nodeFrequencies } from './nodeFrequency';
import { DEFAULT_COMPASS_CONFIG, dataOutCompassFromSnapshot, polarView } from './polar';
import { DEFAULT_POLAR_VIEW_SETTINGS } from './polarViewSettings';
import { SOURCE_REASONS, isMqttSnapshot, mqttAngleMode, mqttDiagnosticRows, snapshotSourceKind, snapshotSourceReasons, sourceBadge } from './telemetrySource';
import { localSnapshotFresh } from '../App';
import { ConsoleShell } from '../components/Shell';
import { DoaReadout } from '../components/DoaReadout';
import { PolarDock } from '../components/overview/PolarDock';

/** An answer of tools/telemetry_source.py, written by tools/test_telemetry_source.py. */
function answer(name: string): TelemetrySnapshot {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/telemetry-source/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text) as TelemetrySnapshot;
}

const healthyView = {
  available: true,
  canonical_angle_deg: 211,
  latitude: -6.2,
  longitude: 106.8,
  frequency_hz_normalized: 416_588_000,
  freshness: { fresh: true, age_ms: 200, max_age_ms: 5000 },
  angular_power_db: Array.from({ length: 360 }, (_, index) => (index === 211 ? 0 : -20)),
};

/** A Data Out answer as an older server or the fallback sends it. */
function dataOut(source?: TelemetrySnapshot['source']): TelemetrySnapshot {
  return {
    ...(source ? { source } : {}),
    status: { available: true, daq_health: 'PASS', safe: { gps_status: 'Fixed', daq_status: { frame_sync: true, sample_delay_sync: true, iq_sync: true } } },
    settings: { available: true, fields: { center_freq: 416.588 } },
    doa_candidates: { csv: { ...healthyView }, xml: { ...healthyView } },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: {}, reasons: ['GROUND_CLOCK_UNVERIFIED'] },
    overall_state: 'UNVERIFIED',
  } as TelemetrySnapshot;
}

function staleMqtt(): TelemetrySnapshot {
  const snapshot = answer('mqtt-live.json');
  const view = snapshot.doa_candidates!.mqtt;
  view.freshness = { ...view.freshness, fresh: false, age_ms: 6_000 };
  snapshot.overall_state = 'STALE';
  return snapshot;
}

const t = (lang: Lang) => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(lang, key, vars);

function strip(snapshot: TelemetrySnapshot | null, lang: Lang = 'en'): Record<string, { value: string; tone: string; title: string | null }> {
  const markup = renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: t(lang) }}>
      <ConsoleShell route="overview" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={snapshot} localSnapshotFresh loading={false} readError={null} lastReadAgeMs={100} simulationEnabled={false} onRefresh={() => undefined}>
        <span />
      </ConsoleShell>
    </I18nContext.Provider>,
  );
  const items: Record<string, { value: string; tone: string; title: string | null }> = {};
  for (const match of markup.matchAll(/<span class="telemetry-item tone-(\w+)"([^>]*)><span class="telemetry-key">([^<]+)<\/span><span class="telemetry-value"><i aria-hidden="true"><\/i>([^<]*)<\/span>/g)) {
    items[match[3]] = { tone: match[1], value: match[4], title: match[2].match(/title="([^"]*)"/)?.[1] ?? null };
  }
  return items;
}

function hud(snapshot: TelemetrySnapshot, lang: Lang = 'en', fresh = true): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: t(lang) }}>
      <DoaReadout snapshot={snapshot} localSnapshotFresh={fresh} settings={{ figType: 'Compass', compassOffset: 12 }} offsetSource="DATA_OUT" offsetVerified />
    </I18nContext.Provider>,
  );
}

describe('the telemetry source of an answer', () => {
  it('reads the source the server names and nothing else', () => {
    expect(snapshotSourceKind(answer('mqtt-live.json'))).toBe('mqtt');
    expect(isMqttSnapshot(answer('mqtt-live.json'))).toBe(true);
    expect(snapshotSourceKind(dataOut())).toBeNull();
    expect(isMqttSnapshot(dataOut())).toBe(false);
    expect(snapshotSourceKind({ source: { kind: 'bogus' } } as TelemetrySnapshot)).toBeNull();
    // A simulation never counts as MQTT, whatever it carries.
    expect(isMqttSnapshot({ ...answer('mqtt-live.json'), simulation: true })).toBe(false);
    expect(snapshotSourceReasons(dataOut({ kind: 'none', reasons: ['MQTT_HEALTH_STALE', 'DATA_OUT_UNAVAILABLE', 'SOMETHING_ELSE'] })))
      .toEqual(['MQTT_HEALTH_STALE', 'DATA_OUT_UNAVAILABLE']);
  });

  it('gives a badge for MQTT, the Data Out fallback and none, in both languages', () => {
    const mqtt = sourceBadge(answer('mqtt-live.json'));
    expect(mqtt).toEqual({ kind: 'mqtt', labelKey: 'source.mqtt', tone: 'good', reasons: [] });
    const fallback = sourceBadge(dataOut({ kind: 'data_out', reason: 'MQTT_HEALTH_STALE', reasons: ['MQTT_HEALTH_STALE'] }));
    expect(fallback?.tone).toBe('warn');
    expect(translate('en', fallback!.labelKey)).toBe('Data Out (fallback)');
    expect(translate('id', fallback!.labelKey)).toBe('Data Out (cadangan)');
    const none = sourceBadge(dataOut({ kind: 'none', reasons: ['MQTT_DISABLED', 'DATA_OUT_UNAVAILABLE'] }));
    expect(none?.tone).toBe('bad');
    expect([translate('en', none!.labelKey), translate('id', none!.labelKey)]).toEqual(['none', 'tidak ada']);
    expect(none?.reasons).toEqual(['MQTT_DISABLED', 'DATA_OUT_UNAVAILABLE']);
    // No badge for an older server or a simulation.
    expect(sourceBadge(dataOut())).toBeNull();
    expect(sourceBadge({ ...answer('mqtt-live.json'), simulation: true })).toBeNull();
    expect(sourceBadge(null)).toBeNull();
  });

  it('gives the Source chip its own place in the strip on narrow screens', () => {
    type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
    const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
    const css = process.getBuiltinModule('node:fs').readFileSync(new URL('../console-design.css', import.meta.url), 'utf8');
    const narrow = css.slice(css.indexOf('@media (max-width: 1023px)'), css.indexOf('@media (max-width: 600px)'));
    expect(narrow).toContain('.telemetry-strip.has-source { grid-template-columns: repeat(7, minmax(0, 1fr)); }');
    const phone = css.match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(phone).toContain('.telemetry-strip.has-source .telemetry-item:first-child { grid-column: 1 / -1; }');
    const markup = (snapshot: TelemetrySnapshot) => renderToStaticMarkup(
      <ConsoleShell route="overview" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={snapshot} localSnapshotFresh loading={false} readError={null} lastReadAgeMs={100} simulationEnabled={false} onRefresh={() => undefined}><span /></ConsoleShell>,
    );
    expect(markup(answer('mqtt-live.json'))).toContain('class="telemetry-strip has-source"');
    expect(markup(dataOut())).toContain('class="telemetry-strip"');
  });

  it('labels every source code in both languages', () => {
    for (const reason of SOURCE_REASONS) {
      const key = `source.reason.${reason}` as Parameters<typeof translate>[1];
      expect(translate('en', key), reason).not.toBe(key);
      expect(translate('id', key), reason).not.toBe(translate('en', key));
    }
    for (const reason of ['MQTT_NO_DOA', 'MQTT_DOA_UNVERIFIED', 'MQTT_ANGLE_CONVENTION_UNKNOWN', 'MQTT_ANGULAR_UNAVAILABLE', 'MQTT_DOA_ANGULAR_CONFLICT']) {
      expect(gateReasonLabel('en', reason), reason).not.toBe(reason);
      expect(gateReasonLabel('id', reason), reason).not.toBe(gateReasonLabel('en', reason));
    }
  });
});

describe('MQTT first, Data Out as the fallback', () => {
  it('shows the DoA from MQTT with the MQTT badge', () => {
    const snapshot = answer('mqtt-live.json');
    expect(sourceViewNames(snapshot)).toEqual(['mqtt']);
    expect(primaryCandidate(snapshot)).toBe(snapshot.doa_candidates!.mqtt);
    expect(nativeViewsReady(snapshot)).toBe(true);
    expect(polarDataReady(snapshot)).toBe(true);
    expect(deriveDataState(snapshot, false, true)).toBe('AVAILABLE');
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'AVAILABLE', shown: true });
    const view = polarView(snapshot, { figType: 'Compass', compassOffset: 0 }, true);
    expect(view.fresh).toBe(true);
    expect(view.canonicalAngle).toBe(160);
    expect(view.peakIndex).toBe(160);
    const items = strip(snapshot);
    expect(items.Source).toEqual({ value: 'MQTT', tone: 'good', title: null });
    expect(items.Data.value).toBe('AVAILABLE');
    expect(items.DoA.value).toBe('AVAILABLE');
    const markup = hud(snapshot);
    expect(markup).toContain('<span class="ov-tag tone-good">MQTT</span>');
    // θ₀ 160° with offset 12°: bearing (360 - 160 + 12) mod 360.
    expect(markup).toContain('212.0');
  });

  it('shows a LIVE MQTT DoA between Angular frames without the curve', () => {
    // The edge sends Angular about every 9 s and none for 20 s after a
    // command: the bearing stays, only the curve waits for the next frame.
    const snapshot = answer('mqtt-live.json');
    const view = snapshot.doa_candidates!.mqtt;
    for (const key of ['angular_power_db', 'angular_peak_index', 'angular_peak_value', 'angular_peak_db', 'angular_bins'] as const) delete (view as Record<string, unknown>)[key];
    view.angular_pairing = 'PEAK_MOVED';
    snapshot.native_consistency = { ...snapshot.native_consistency, comparable: false, frame_relation: 'INCOMPLETE', angle_checked: false, conflict: false };
    snapshot.publication_gate!.reasons = [...(snapshot.publication_gate!.reasons ?? []), 'MQTT_ANGULAR_UNAVAILABLE'];
    expect(polarDataReady(snapshot)).toBe(false);
    expect(deriveDataState(snapshot, false, true)).toBe('AVAILABLE');
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'AVAILABLE', shown: true });
    const polar = polarView(snapshot, { figType: 'Compass', compassOffset: 0 }, true);
    expect(polar.values).toBeNull();
    expect(polar.canonicalAngle).toBe(160);
    expect(hud(snapshot)).toContain('212.0');
    const dock = (lang: Lang) => renderToStaticMarkup(
      <I18nContext.Provider value={{ lang, setLang: () => undefined, t: t(lang) }}>
        <PolarDock snapshot={snapshot} localSnapshotFresh settings={{ figType: 'Polar', compassOffset: 12 }} offsetSource="DATA_OUT" offsetVerified compassConfig={DEFAULT_COMPASS_CONFIG} view={DEFAULT_POLAR_VIEW_SETTINGS} onViewChange={() => undefined} />
      </I18nContext.Provider>,
    );
    expect(dock('en')).toContain('θ₀ 160.0°');
    expect(dock('en')).toContain(`<span class="is-warn"> · ${translate('en', 'polarDock.noCurve')}</span>`);
    expect(dock('id')).toContain(translate('id', 'polarDock.noCurve'));
    expect(renderToStaticMarkup(
      <PolarDock snapshot={answer('mqtt-live.json')} localSnapshotFresh settings={{ figType: 'Polar', compassOffset: 12 }} offsetSource="DATA_OUT" offsetVerified compassConfig={DEFAULT_COMPASS_CONFIG} view={DEFAULT_POLAR_VIEW_SETTINGS} onViewChange={() => undefined} />,
    )).not.toContain(translate('en', 'polarDock.noCurve'));
    // It comes and goes with the frames and needs no action.
    expect(actionableGateReasons(snapshot.publication_gate!.reasons)).not.toContain('MQTT_ANGULAR_UNAVAILABLE');
    // A Data Out answer still needs the vector.
    const legacy = dataOut();
    delete (legacy.doa_candidates!.csv as Record<string, unknown>).angular_power_db;
    expect(overviewDoaStatus(legacy, true)).toMatchObject({ code: 'INCOMPLETE', reason: 'vectorIncomplete', shown: false });
  });

  it('takes what MQTT never carries from the light Data Out read', () => {
    const snapshot = answer('mqtt-live.json');
    expect(nodeFrequencies(snapshot, true)).toEqual({ centerHz: 433_920_000, vfoHz: 433_920_000 });
    expect(dataOutCompassFromSnapshot(snapshot)).toMatchObject({ figType: 'Compass', compassOffset: 12 });
    expect(resolveStationCoordinate(snapshot)).toEqual({ latitude: -6.2, longitude: 106.8, source: 'XML' });
    expect(resolveGpsSource(snapshot).coordinate).toEqual({ latitude: -6.2, longitude: 106.8, source: 'DATA_OUT' });
    expect(gpsReportsNoFix(snapshot, true)).toBe(false);
  });

  it('keeps showing the DoA with the MQTT badge when Data Out is dead', () => {
    const snapshot = answer('mqtt-data-out-dead.json');
    expect(snapshot.data_out_light?.status).toMatchObject({ available: false });
    // MQTT never carries the ADC overdrive: without a light read it is
    // unknown, so the bearing is shown DEGRADED with that cause.
    expect(snapshot.publication_gate?.reasons).toContain('ADC_OVERDRIVE_UNKNOWN');
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'DEGRADED', reason: 'adcUnknown', shown: true });
    expect(strip(snapshot).Source.value).toBe('MQTT');
    expect(strip(snapshot).DoA.value).toBe('DEGRADED');
    for (const lang of ['en', 'id'] as const) {
      const markup = hud(snapshot, lang);
      expect(markup).toContain('212.0');
      expect(markup).toContain(`<p class="ov-hud-held">${translate(lang, 'polar.adcUnknown')}</p>`);
      expect(gateReasonLabel(lang, 'ADC_OVERDRIVE_UNKNOWN')).not.toBe('ADC_OVERDRIVE_UNKNOWN');
    }
    expect(actionableGateReasons(snapshot.publication_gate!.reasons)[0]).toBe('ADC_OVERDRIVE_UNKNOWN');
    // With a current light read the overdrive is known and the DoA is AVAILABLE.
    expect(overviewDoaStatus(answer('mqtt-live.json'), true)).toMatchObject({ code: 'AVAILABLE', shown: true });
    // A Data Out answer without an overdrive verdict is unchanged.
    expect(overviewDoaStatus(dataOut(), true)).toMatchObject({ code: 'AVAILABLE', shown: true });
    expect(hud(snapshot)).toContain('<span class="ov-tag tone-good">MQTT</span>');
    // No settings and no position, but no "no fix" either: a held position stays.
    expect(nodeFrequencies(snapshot, true)).toBeNull();
    expect(resolveStationCoordinate(snapshot)).toBeNull();
    expect(gpsReportsNoFix(snapshot, true)).toBe(false);
    const held = { latitude: -6.2, longitude: 106.8, source: 'DATA_OUT' as const };
    expect(holdStationCoordinate(held, resolveGpsSource(snapshot).coordinate, gpsReportsNoFix(snapshot, true), 'DATA_OUT'))
      .toMatchObject({ coordinate: held, held: true });
  });

  it('switches to the Data Out fallback with its badge and cause', () => {
    const snapshot = dataOut({ kind: 'data_out', reason: 'MQTT_HEALTH_STALE', reasons: ['MQTT_HEALTH_STALE'] });
    expect(sourceViewNames(snapshot)).toEqual(['csv', 'xml']);
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'AVAILABLE', shown: true });
    for (const lang of ['en', 'id'] as const) {
      const items = strip(snapshot, lang);
      const source = items[translate(lang, 'status.source')];
      expect(source.value).toBe(translate(lang, 'source.dataOut'));
      expect(source.tone).toBe('warn');
      expect(source.title).toBe(`MQTT_HEALTH_STALE · ${translate(lang, 'source.reason.MQTT_HEALTH_STALE')}`);
    }
    expect(hud(snapshot, 'id')).toContain('<span class="ov-tag tone-warn">Data Out (cadangan)</span>');
  });

  it('says there is no source when MQTT is stale and Data Out is dead', () => {
    const snapshot = { ...dataOut({ kind: 'none', reasons: ['MQTT_HEALTH_STALE', 'DATA_OUT_UNAVAILABLE'] }), status: { available: false } } as TelemetrySnapshot;
    const items = strip(snapshot, 'id');
    expect(items.Sumber).toMatchObject({ value: 'tidak ada', tone: 'bad' });
    expect(items.Sumber.title).toBe(`MQTT_HEALTH_STALE · ${translate('id', 'source.reason.MQTT_HEALTH_STALE')}\nDATA_OUT_UNAVAILABLE · ${translate('id', 'source.reason.DATA_OUT_UNAVAILABLE')}`);
    expect(items.Data.value).toBe('UNAVAILABLE');
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'UNAVAILABLE', shown: false });
  });

  it('never shows a stale MQTT DoA', () => {
    const snapshot = staleMqtt();
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'STALE', reason: 'sourceStale', shown: false });
    expect(deriveDataState(snapshot, false, true)).toBe('STALE');
    expect(hud(snapshot)).not.toContain('212.0');
    // A fresh answer expires locally like a Data Out one: 5 s from the DoA.
    const fresh = answer('mqtt-live.json');
    expect(localSnapshotFresh(fresh, 1_000, 5_900)).toBe(true);
    expect(localSnapshotFresh(fresh, 1_000, 6_100)).toBe(false);
    expect(overviewDoaStatus(fresh, false)).toMatchObject({ code: 'STALE', reason: 'localExpired', shown: false });
  });

  it('keeps an UNVERIFIED DoA a diagnostic', () => {
    const snapshot = answer('mqtt-unverified.json');
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'UNVERIFIED', reason: 'mqttUnverified', shown: false });
    expect(deriveDataState(snapshot, false, true)).toBe('AVAILABLE');
    expect(polarView(snapshot, { figType: 'Compass', compassOffset: 0 }, true).values).toBeNull();
    expect(candidateErrors(snapshot)).toEqual(['MQTT: no LIVE telemetry/doa (ok=1) in this session']);
    const rows = mqttDiagnosticRows(snapshot);
    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ['doa_unverified', 'UNVERIFIED'],
      ['angular_unverified', 'UNVERIFIED'],
    ]);
    expect(rows[0]).toMatchObject({ thetaDeg: 160, frequencyHz: 433_920_000, reasons: ['SOURCE_UNVERIFIED', 'ANGLE_UNVERIFIED'] });
    expect(mqttAngleMode(snapshot)).toBe('theta_mirror');
    const markup = hud(snapshot);
    expect(markup).toContain(translate('en', 'polar.mqttUnverified'));
    expect(markup).not.toContain('212.0');
    expect(strip(snapshot).DoA.value).toBe('UNVERIFIED');
  });

  it('lists the LIVE parts of an MQTT answer for DoA Diagnostics', () => {
    const rows = mqttDiagnosticRows(answer('mqtt-live.json'));
    expect(rows.map((row) => [row.key, row.status, row.thetaDeg])).toEqual([
      ['doa', 'LIVE', 160],
      ['angular', 'LIVE', 160],
      ['diagnostic_doa', 'UNVERIFIED', 160],
      ['angular_unverified', 'UNVERIFIED', 160],
    ]);
    expect(mqttDiagnosticRows(dataOut())).toEqual([]);
  });
});
