import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { DoaReadout } from '../components/DoaReadout';
import { EstimatePanel } from '../components/overview/EstimatePanel';
import { overviewDoaStatus, provisionalDoa, provisionalTheta } from './doaStatus';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { normalizeRdfNodeSnapshot } from './mqttMonitor';
import { DEFAULT_COMPASS_CONFIG, angularFrameHeading, binsAtBearing, curveCompassOffset, curveInDoaFrame, geographicBearingForBin, heldBearing, polarView, resolveCompassSource } from './polar';
import { estimateWaitKey, positionEstimate } from './positionEstimate';
import { angularFrameAgeMs, angularHeld, edgeDoaReasonKey, edgeDoaReasons } from './telemetrySource';

// Edge contract 1.10 as the console reads it (tools/telemetry_source.py, docs/MQTT_KONTRAK.md 7e, 8.3b):
// the heading of an ok=0 sample, the heading and the LoRa hold of the Angular frame, the edge's own
// reasons (health.why, the ok=0 reason) and what the position estimate waits for.

/** An answer of tools/telemetry_source.py, written by tools/test_telemetry_source.py. */
function answer(name: string): TelemetrySnapshot {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/telemetry-source/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text) as TelemetrySnapshot;
}

function wrap(lang: Lang, node: JSX.Element): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{node}</I18nContext.Provider>,
  );
}

function hud(snapshot: TelemetrySnapshot, lang: Lang = 'en', offsetManual = false): string {
  return wrap(lang, (
    <DoaReadout snapshot={snapshot} localSnapshotFresh settings={{ figType: 'Compass', compassOffset: 0 }} offsetSource="FALLBACK" offsetVerified={false} offsetManual={offsetManual} />
  ));
}

/** The LIVE DoA of mqtt-lora-held.json gone stale, beside a newer or older ok=0 sample. */
function staleLiveWith(unverified: Record<string, unknown> | null): TelemetrySnapshot {
  const base = answer('mqtt-lora-held.json');
  const view = base.doa_candidates?.mqtt as Record<string, unknown>;
  return {
    ...base,
    doa_candidates: { mqtt: { ...view, freshness: { ...(view.freshness as object), fresh: false, age_ms: 40_000 }, received_at_ms: 1_000 } },
    mqtt: { ...(base.mqtt as Record<string, unknown>), doa_unverified: unverified },
  } as TelemetrySnapshot;
}

describe('a held DoA turns with the heading of its own sample (D1, D2)', () => {
  it('draws an ok=0 sample at h - theta_0 without any LIVE DoA, needing no compass offset', () => {
    const snapshot = answer('mqtt-lora-unverified-heading.json');
    const status = overviewDoaStatus(snapshot, true);
    expect(status).toMatchObject({ code: 'UNVERIFIED', reason: 'loraUnverified', shown: false });
    expect(provisionalDoa(snapshot, status)).toEqual({ thetaDeg: 30, headingDeg: 100, unverified: true });
    // theta_0 30 with h 100 is bearing 70 (the server's own bearing_deg), not 360 - 30 + 0 = 330.
    expect(heldBearing(30, 100, 0)).toEqual({ bearingDeg: 70, nodeHeading: true });
    expect((snapshot.mqtt as Record<string, Record<string, unknown>>).doa_unverified.bearing_deg).toBe(70);
    // Without a heading the offset in use turns it, and the map names that offset.
    expect(heldBearing(30, null, 0)).toEqual({ bearingDeg: 330, nodeHeading: false });
    expect(heldBearing(null, 100, 0)).toBeNull();
    expect(hud(snapshot)).toContain('ov-hud-bearing is-provisional">70.0<small>°</small>');
  });

  it('keeps a manual offset above the sample heading, as for a LIVE DoA', () => {
    expect(hud(answer('mqtt-lora-unverified-heading.json'), 'en', true)).toContain('ov-hud-bearing is-provisional">330.0<small>°</small>');
  });

  it('prefers a current ok=0 sample newer than a stale LIVE one, each with its own heading', () => {
    const newer = staleLiveWith({ canonical_angle_deg: 200, array_heading_deg: 50, received_at_ms: 2_000, stale: false });
    const status = overviewDoaStatus(newer, true);
    expect(status).toMatchObject({ code: 'STALE', reason: 'sourceStale', shown: false });
    expect(provisionalDoa(newer, status)).toEqual({ thetaDeg: 200, headingDeg: 50, unverified: true });
    expect(geographicBearingForBin(200, 50)).toBe(210);
    // An older or stale ok=0 sample leaves the last LIVE angle with the LIVE heading.
    for (const unverified of [
      { canonical_angle_deg: 200, array_heading_deg: 50, received_at_ms: 500, stale: false },
      { canonical_angle_deg: 200, array_heading_deg: 50, received_at_ms: 2_000, stale: true },
      null,
    ]) {
      const snapshot = staleLiveWith(unverified);
      expect(provisionalDoa(snapshot, overviewDoaStatus(snapshot, true))).toEqual({ thetaDeg: 160, headingDeg: 100, unverified: false });
    }
    // The heading-less sample of an older edge still gives its angle.
    const older = staleLiveWith({ canonical_angle_deg: 200, received_at_ms: 2_000, stale: false });
    expect(provisionalDoa(older, overviewDoaStatus(older, true))).toEqual({ thetaDeg: 200, headingDeg: null, unverified: true });
    expect(provisionalTheta(older, overviewDoaStatus(older, true))).toBe(200);
  });

  it('shows the newer ok=0 sample on the HUD with its own tag, age and signal line', () => {
    const newer = staleLiveWith({ canonical_angle_deg: 200, array_heading_deg: 50, received_at_ms: 2_000, stale: false, age_ms: 1_500, f: 145_500_000, p: -61.3 });
    const markup = hud(newer);
    expect(markup).toContain('ov-hud-bearing is-provisional">210.0<small>°</small>');
    expect(markup).toContain('<span class="ov-tag tone-neutral">NOT VALID</span>');
    expect(markup).not.toContain('STALE 40.0 s');
    expect(markup).toContain(`<span class="ov-hud-age">${translate('en', 'hud.age', { age: '1.5 s' })}</span>`);
    expect(markup).toContain('ov-hud-sample is-provisional');
    expect(markup).toContain('145.500 MHz · -61.3 dB');
    // The last LIVE DoA, with no newer ok=0 sample, keeps its STALE tag and age.
    const held = hud(staleLiveWith(null));
    expect(held).toContain('ov-hud-bearing is-provisional">300.0<small>°</small>');
    expect(held).toContain('STALE 40.0 s');
    expect(held).not.toContain('145.500 MHz');
  });

  it('gives no held DoA while a DoA is shown', () => {
    const live = answer('mqtt-lora-held.json');
    expect(provisionalDoa(live, overviewDoaStatus(live, true))).toBeNull();
  });
});

describe('the edge says why the DoA is not LIVE (D3, N2)', () => {
  it('reads the ok=0 reason and health.why, in words, with the codes kept', () => {
    const snapshot = answer('mqtt-lora-unverified-heading.json');
    expect(edgeDoaReasons(snapshot)).toEqual(['CONTROL_IN_PROGRESS']);
    for (const lang of ['en', 'id'] as const) {
      const markup = hud(snapshot, lang);
      expect(markup).toContain(`title="CONTROL_IN_PROGRESS">${translate(lang, 'hud.edgeWhy', { reasons: translate(lang, 'edgeReason.CONTROL_IN_PROGRESS') })}</p>`);
    }
    expect(edgeDoaReasonKey('EMPTY_CSV')).toBe('edgeReason.EMPTY_CSV');
    expect(edgeDoaReasonKey('CSV_FIELD_COUNT')).toBe('edgeReason.CSV_MALFORMED');
    expect(edgeDoaReasonKey('SOMETHING_NEW')).toBeNull();
  });

  it('falls back to the reason list of an edge that sent no validation_reasons, then adds health.why', () => {
    const base = answer('mqtt-lora-unverified-heading.json');
    const mqtt = base.mqtt as Record<string, Record<string, unknown>>;
    const snapshot = {
      ...base,
      mqtt: {
        ...mqtt,
        doa_unverified: { ...mqtt.doa_unverified, validation_reasons: [], reason: ['CLOCK_UNTRUSTED', 'bad code'] },
        health: { ...mqtt.health, why: ['CLOCK_UNTRUSTED', 'EMPTY_CSV', 'NEW_EDGE_CODE'] },
      },
    } as TelemetrySnapshot;
    expect(edgeDoaReasons(snapshot)).toEqual(['CLOCK_UNTRUSTED', 'EMPTY_CSV', 'NEW_EDGE_CODE']);
    expect(hud(snapshot)).toContain('RDF-SDR: clock not synchronized · DoA CSV empty · NEW_EDGE_CODE');
    // A stale ok=0 sample and a stale health say nothing.
    const stale = { ...snapshot, mqtt: { ...snapshot.mqtt, doa_unverified: { ...mqtt.doa_unverified, stale: true }, health: { ...mqtt.health, fresh: false, why: ['EMPTY_CSV'] } } } as TelemetrySnapshot;
    expect(edgeDoaReasons(stale)).toEqual([]);
  });

  it('reads source.mqtt.health_why of a Data Out or empty answer while that health is fresh', () => {
    const none = {
      status: { available: false },
      source: { kind: 'none', reason: 'MQTT_DAQ_NOT_HEALTHY', link: 'lora', mqtt: { health_age_ms: 1_500, health_fresh_ms: 8_000, health_why: ['DAQ_NOT_HEALTHY', 'EMPTY_CSV'] } },
    } as unknown as TelemetrySnapshot;
    expect(edgeDoaReasons(none)).toEqual(['DAQ_NOT_HEALTHY', 'EMPTY_CSV']);
    expect(hud(none, 'id')).toContain('RDF-SDR: DAQ tidak sehat · CSV DoA kosong');
    const aged = { ...none, source: { ...none.source, mqtt: { health_age_ms: 9_000, health_fresh_ms: 8_000, health_why: ['EMPTY_CSV'] } } } as unknown as TelemetrySnapshot;
    expect(edgeDoaReasons(aged)).toEqual([]);
    // An older edge sends no why; a simulation never has one.
    expect(edgeDoaReasons({ ...none, source: { ...none.source, mqtt: { health_age_ms: 1, health_fresh_ms: 8_000, health_why: null } } } as unknown as TelemetrySnapshot)).toEqual([]);
    expect(edgeDoaReasons({ ...none, simulation: true } as TelemetrySnapshot)).toEqual([]);
    // The shown DoA needs no reason line.
    expect(hud(answer('mqtt-lora-held.json'))).not.toContain('RDF-SDR:');
  });

  it('names health.why on the health row of the Message Monitor', () => {
    type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
    const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
    const body = JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/rdf-node/api-snapshot.json', import.meta.url), 'utf8')) as Record<string, any>;
    const health = normalizeRdfNodeSnapshot({ ...body, node: { ...body.node, health: { ...body.node.health, why: ['EMPTY_CSV', 'bad code'] } } }, Date.now()).node.parts.health;
    expect(health?.reasons).toEqual(['EMPTY_CSV']);
    const older = { ...body.node.health };
    delete older.why;
    expect(normalizeRdfNodeSnapshot({ ...body, node: { ...body.node, health: older } }, Date.now()).node.parts.health?.reasons).toEqual([]);
  });
});

describe('the Angular curve turns with the heading of its own frame (N3)', () => {
  const snapshot = answer('mqtt-lora-held.json');

  it('uses the frame heading only while the DoA heading turns the bearing', () => {
    const compass = resolveCompassSource(snapshot, { figType: 'Compass', compassOffset: 0 }, DEFAULT_COMPASS_CONFIG);
    expect(compass).toMatchObject({ code: 'NODE_HEADING', settings: { compassOffset: 100 } });
    expect(angularFrameHeading(snapshot)).toBe(90);
    expect(curveCompassOffset(snapshot, compass, 100)).toBe(90);
    // A manual offset turns the curve as it turns the bearing; an edge without frame headings keeps the offset.
    expect(curveCompassOffset(snapshot, { code: 'MANUAL' }, 12)).toBe(12);
    const older = { ...snapshot, doa_candidates: { mqtt: { ...snapshot.doa_candidates?.mqtt, angular_heading_deg: null } } } as TelemetrySnapshot;
    expect(curveCompassOffset(older, compass, 100)).toBe(100);
    expect(angularFrameHeading({ ...snapshot, simulation: true })).toBeNull();
  });

  it('puts the curve peak on the DoA bearing although the platform turned 10 degrees since the frame', () => {
    const view = snapshot.doa_candidates?.mqtt as Record<string, unknown>;
    expect([view.angular_peak_index, view.canonical_angle_deg, view.array_heading_deg, view.angular_heading_deg]).toEqual([150, 160, 100, 90]);
    // The frame's peak bin 150 at heading 90 and the DoA's theta_0 160 at heading 100 are the same bearing.
    expect(geographicBearingForBin(150, 90)).toBe(geographicBearingForBin(160, 100));
    const settings = { figType: 'Compass' as const, compassOffset: 100 };
    const turned = polarView(snapshot, settings, true, null, settings, 90);
    expect([turned.peakIndex, turned.displayPeak]).toEqual([160, 300]);
    // Without the frame heading the peak would sit 10 degrees off the bearing.
    const plain = polarView(snapshot, settings, true, null, settings);
    expect([plain.peakIndex, plain.displayPeak]).toEqual([150, 310]);
    // Equal answers keep one turned array, so the plot is not redrawn on every tick.
    expect(polarView(snapshot, settings, true, null, settings, 90).values).toBe(turned.values);
  });

  it('moves every bin by the whole degrees between the two offsets, and leaves an aligned curve alone', () => {
    const values = Array.from({ length: 360 }, (_, bin) => bin);
    const turned = curveInDoaFrame(values, 100, 90);
    expect(turned?.[10]).toBe(0);
    expect(turned?.[0]).toBe(350);
    expect(curveInDoaFrame(values, 90, 100)?.[0]).toBe(10);
    expect(curveInDoaFrame(values, 90, 90)).toBe(values);
    expect(curveInDoaFrame(null, 90, 100)).toBeNull();
  });

  it('reads the map hover value from the frame bin and names theta_0 in the DoA frame', () => {
    // The DoA bearing 300: frame bin 150 (heading 90) holds the peak, the HUD calls it theta_0 160 (heading 100).
    expect(binsAtBearing(300, 90, 100)).toEqual({ frameBin: 150, theta: 160 });
    expect(binsAtBearing(300, 100, 100)).toEqual({ frameBin: 160, theta: 160 });
    // A bearing that rounds up to 360 is bin 0.
    expect(binsAtBearing(100.4, 100, 100)).toEqual({ frameBin: 0, theta: 0 });
  });
});

describe('a held Angular curve over LoRa is drawn dimmed with its age (X1, N6)', () => {
  it('is marked held with the age of its frame', () => {
    const snapshot = answer('mqtt-lora-held.json');
    expect(angularHeld(snapshot)).toBe(true);
    expect(angularFrameAgeMs(snapshot)).toBe(15_000);
    const view = snapshot.doa_candidates?.mqtt as Record<string, unknown>;
    expect(view.angular_power_db).toHaveLength(360);
    expect(overviewDoaStatus(snapshot, true)).toMatchObject({ code: 'DEGRADED', shown: true });
    const fresh = { ...snapshot, doa_candidates: { mqtt: { ...view, angular_held: false } } } as TelemetrySnapshot;
    expect(angularHeld(fresh)).toBe(false);
    expect(angularHeld(answer('mqtt-live.json'))).toBe(false);
    expect(translate('en', 'polarDock.angularHeld', { age: '15 s' })).toBe('Angular 15 s ago · held');
    expect(translate('id', 'map.vectorHeld', { bearing: '300°', age: '15 dtk' })).toBe('360 bin · 300° · kurva 15 dtk lalu');
  });
});

describe('the position estimate says what it waits for (D6)', () => {
  const waiting = (estimate: Record<string, unknown>, position: boolean | null = null) => positionEstimate({
    position_estimate: { state: 'NO_DATA', samples: 0, stations: 0, method: { min_stations: 3, min_spread_deg: 15 }, ...estimate },
    mqtt: position === null ? {} : { capabilities: { nav: { compass: true, gps: true, position, heading: 'compass' } } },
  } as unknown as TelemetrySnapshot)!;

  it('names a withheld position, a missing position and a missing heading', () => {
    const withheld = waiting({ waiting_for: 'NO_POSITION', skipped: 12, skipped_at_ms: 1 }, false);
    expect(withheld).toMatchObject({ waitingFor: 'NO_POSITION', skipped: 12, positionWithheld: true });
    expect(estimateWaitKey(withheld)).toBe('estimate.waitPositionWithheld');
    expect(estimateWaitKey(waiting({ waiting_for: 'NO_POSITION' }, true))).toBe('estimate.waitPosition');
    expect(estimateWaitKey(waiting({ waiting_for: 'NO_POSITION' }))).toBe('estimate.waitPosition');
    expect(estimateWaitKey(waiting({ waiting_for: 'NO_BEARING' }))).toBe('estimate.waitBearing');
    // An older console sends none of it.
    const older = waiting({});
    expect(older).toMatchObject({ waitingFor: null, skipped: 0, positionWithheld: null, nodeGpsFix: null });
    expect(estimateWaitKey(older)).toBeNull();
    expect(waiting({ waiting_for: 'SOMETHING' }).waitingFor).toBeNull();
  });

  it('forgets a skip from before Start over, and names a node GPS without a fix', () => {
    // The console's counter outlives a reset: a last skip before reset_at_ms is not shown.
    const before = waiting({ waiting_for: 'NO_POSITION', skipped: 12, skipped_at_ms: 1_000, reset_at_ms: 2_000 });
    expect(before).toMatchObject({ waitingFor: null, skipped: 0 });
    expect(estimateWaitKey(before)).toBeNull();
    const after = waiting({ waiting_for: 'NO_BEARING', skipped: 13, skipped_at_ms: 3_000, reset_at_ms: 2_000 });
    expect(after).toMatchObject({ waitingFor: 'NO_BEARING', skipped: 13 });
    const noFix = positionEstimate({
      position_estimate: { state: 'NO_DATA', waiting_for: 'NO_POSITION', skipped: 2 },
      nav: { gps_state: 'NO_FIX', latitude: null, longitude: null },
    } as unknown as TelemetrySnapshot)!;
    expect(noFix.nodeGpsFix).toBe(false);
    expect(estimateWaitKey(noFix)).toBe('estimate.waitGpsFix');
    // A withheld position says more than the fix; a node with a fix but no position is the plain case.
    expect(estimateWaitKey({ ...noFix, positionWithheld: true })).toBe('estimate.waitPositionWithheld');
    expect(estimateWaitKey({ ...noFix, nodeGpsFix: true })).toBe('estimate.waitPosition');
  });

  it.each(['en', 'id'] as const)('shows it on the estimate card in %s', (lang) => {
    const markup = wrap(lang, <EstimatePanel estimate={waiting({ waiting_for: 'NO_POSITION', skipped: 12 }, false)} viewOnly />);
    expect(markup).toContain(`${translate(lang, 'estimate.waitPositionWithheld')} · ${translate(lang, 'estimate.skipped', { count: '12' })}`);
    expect(markup).not.toContain(translate(lang, 'estimate.stateNoData'));
    const bearing = wrap(lang, <EstimatePanel estimate={waiting({ waiting_for: 'NO_BEARING' })} viewOnly />);
    expect(bearing).toContain(translate(lang, 'estimate.waitBearing'));
    const plain = wrap(lang, <EstimatePanel estimate={waiting({})} viewOnly />);
    expect(plain).toContain(translate(lang, 'estimate.stateNoData'));
  });
});
