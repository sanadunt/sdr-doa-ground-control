import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DoaReadout } from '../components/DoaReadout';
import { NodeCard, rfRows } from '../components/overview/NodeCard';
import { RdfNodeView } from '../pages/MessageMonitorPage';
import { SystemHealthPage, overdriveSourceFile } from '../pages/SystemHealthPage';
import type { MqttSnapshot, TelemetrySnapshot } from '../types';
import { overviewDoaStatus } from './doaStatus';
import { signalQualityView } from './healthView';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { normalizeLoraLink } from './loraLink';
import { resolveStationCoordinate } from './map';
import { normalizeRdfNodeSnapshot } from './mqttMonitor';
import { nodeFrequencies } from './nodeFrequency';
import { doaSample, doaSampleText, snapshotRf } from './telemetrySource';

type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
function read(path: string): Record<string, any> {
  return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/${path}`, import.meta.url), 'utf8'));
}

// Answers of tools/telemetry_source.py (written by tools/test_telemetry_source.py).
// Edge 1.7 over Telemetry LoRa: state.rf, detail.ovr, only an UNVERIFIED (ok=0) DoA.
const LORA_RF = read('telemetry-source/mqtt-lora-rf.json') as TelemetrySnapshot;
const LORA_NAV = read('telemetry-source/mqtt-lora-nav.json') as TelemetrySnapshot;
const LIVE = read('telemetry-source/mqtt-live.json') as TelemetrySnapshot;
const UNVERIFIED = read('telemetry-source/mqtt-unverified.json') as TelemetrySnapshot;
const LORA_MQTT: MqttSnapshot = { connection: 'connected', lora: normalizeLoraLink(read('lora-link/views.json').receiving) };

function withRf(base: TelemetrySnapshot, rf: Record<string, unknown> | null): TelemetrySnapshot {
  return { ...base, rf };
}

function withUnverified(base: TelemetrySnapshot, patch: Record<string, unknown>): TelemetrySnapshot {
  const mqtt = base.mqtt as Record<string, any>;
  return { ...base, mqtt: { ...mqtt, doa_unverified: { ...mqtt.doa_unverified, ...patch } } };
}

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function node(snapshot: TelemetrySnapshot, lang: Lang = 'en', fresh = true): string {
  return render(<NodeCard snapshot={snapshot} localSnapshotFresh={fresh} coordinate={resolveStationCoordinate(snapshot)} positionHeld={false} compassOffset={0} offsetSource="DATA_OUT" offsetManual={false} collapsed={false} onToggle={() => undefined} />, lang);
}

function hud(snapshot: TelemetrySnapshot, lang: Lang = 'en', fresh = true): string {
  return render(<DoaReadout snapshot={snapshot} localSnapshotFresh={fresh} settings={{ figType: 'Compass', compassOffset: 0 }} offsetSource="DATA_OUT" offsetVerified />, lang);
}

function sample(snapshot: TelemetrySnapshot, fresh = true) {
  return doaSample(snapshot, overviewDoaStatus(snapshot, fresh), fresh);
}

/** The text of the <dd> after a <dt>, with its class. */
function row(markup: string, label: string): { text: string; className: string } | null {
  const match = new RegExp(`<dt>${label}</dt><dd(?: class="([^"]*)")?>([^<]*)</dd>`).exec(markup);
  return match ? { className: match[1] ?? '', text: match[2] } : null;
}

describe('state.rf of an MQTT answer (edge 1.7)', () => {
  it('reads what the SDR is set to', () => {
    expect(snapshotRf(LORA_RF)).toEqual({ cfg: 298, centerHz: 103_100_000, vfo0Hz: 103_100_000, gainDb: 12.5, bandwidthHz: 12_500, squelchDb: -100, ucaM: null, squelchMode: null });
  });

  it('is null without state.rf, for a Data Out answer and for a simulation', () => {
    expect(snapshotRf(LIVE)).toBeNull();
    expect(snapshotRf(LORA_NAV)).toBeNull();
    expect(snapshotRf(null)).toBeNull();
    expect(snapshotRf({ ...LORA_RF, source: { ...LORA_RF.source, kind: 'data_out' } })).toBeNull();
    expect(snapshotRf({ ...LORA_RF, source: undefined })).toBeNull();
    expect(snapshotRf({ ...LORA_RF, simulation: true })).toBeNull();
    expect(snapshotRf(withRf(LORA_RF, null))).toBeNull();
  });

  it('drops each value that is missing, of the wrong type or out of range', () => {
    const rf = snapshotRf(withRf(LORA_RF, {
      cfg: 1.5,
      center_frequency_hz: '103100000',
      vfo0_frequency_hz: 500_000,
      gain_db: Number.NaN,
      vfo0_bandwidth_hz: 0,
      vfo0_squelch_db: 99,
    }));
    expect(rf).toBeNull();
    expect(snapshotRf(withRf(LORA_RF, { center_frequency_hz: 7e9, gain_db: Infinity, vfo0_squelch_db: -100 }))).toEqual({
      cfg: null, centerHz: null, vfo0Hz: null, gainDb: null, bandwidthHz: null, squelchDb: -100, ucaM: null, squelchMode: null,
    });
    expect(snapshotRf(withRf(LORA_RF, { center_frequency_hz: 433_920_000.4 }))?.centerHz).toBe(433_920_000);
  });
});

describe('the DoA record behind the Dashboard', () => {
  it('is the shown LIVE DoA, verified', () => {
    expect(sample(LIVE)).toEqual({ frequencyHz: 433_920_000, powerDb: -54.2, verified: true });
    expect(doaSampleText({ frequencyHz: 433_920_000, powerDb: -54.2, verified: true })).toBe('433.920 MHz · -54.2 dB');
    expect(doaSampleText({ frequencyHz: 103_100_000, powerDb: null, verified: false })).toBe('103.100 MHz');
  });

  it('is the UNVERIFIED ok=0 record while no DoA is shown, marked unverified', () => {
    expect(sample(LORA_RF)).toEqual({ frequencyHz: 103_100_000, powerDb: -54.2, verified: false });
    expect(sample(UNVERIFIED)).toEqual({ frequencyHz: 433_920_000, powerDb: -54.2, verified: false });
    // It never becomes a DoA view.
    expect(LORA_RF.doa_candidates?.mqtt?.available).toBe(false);
  });

  it('is nothing once the record or the local window is stale, or the values are unusable', () => {
    expect(sample(LORA_RF, false)).toBeNull();
    expect(sample(LIVE, false)).toBeNull();
    expect(sample(withUnverified(LORA_RF, { stale: true }))).toBeNull();
    expect(sample(withUnverified(LORA_RF, { f: 'x' }))).toBeNull();
    expect(sample(withUnverified(LORA_RF, { p: 'x' }))).toEqual({ frequencyHz: 103_100_000, powerDb: null, verified: false });
    expect(sample({ ...LIVE, simulation: true })).toBeNull();
    expect(sample(null as unknown as TelemetrySnapshot)).toBeNull();
  });

  it('keeps a held reason that hides the angle from showing the ok=0 record', () => {
    const conflict = { ...LORA_RF, native_consistency: { ...LORA_RF.native_consistency, conflict: true } } as TelemetrySnapshot;
    expect(sample(conflict)).toBeNull();
  });
});

describe('Node card with state.rf', () => {
  it('shows the configured centre and gain marked as a setting, and the settings rows', () => {
    const markup = node(LORA_RF);
    expect(markup).toContain('103.100 MHz · gain 12.5 dB · setting');
    expect(markup).not.toContain('Frequency and gain not available over Telemetry LoRa');
    expect(row(markup, 'Center frequency')?.text).toBe('103.100 MHz · setting');
    expect(row(markup, 'Gain')?.text).toBe('12.5 dB · setting');
    expect(row(markup, 'VFO0')?.text).toBe('103.100 MHz · setting');
    expect(row(markup, 'Bandwidth')?.text).toBe('12.5 kHz · setting');
    expect(row(markup, 'Squelch')?.text).toBe('-100.0 dB · setting');
    // SNR still cannot come over the link.
    expect(row(markup, 'SNR')?.text).toBe('not available over Telemetry LoRa');
    expect(node(LORA_RF, 'id')).toContain('103.100 MHz · gain 12.5 dB · setelan');
  });

  it('shows the UNVERIFIED record dimmed and named, never as a valid value', () => {
    const doa = row(node(LORA_RF), 'DoA signal');
    expect(doa).toEqual({ text: '103.100 MHz · -54.2 dB · UNVERIFIED', className: 'is-provisional' });
    expect(row(node(LORA_RF, 'en', false), 'DoA signal')).toBeNull();
  });

  it('shows the ADC state the edge reported in health/detail', () => {
    expect(row(node(LORA_RF), 'ADC')).toEqual({ text: 'OK', className: 'is-good' });
    const overdrive = { ...LORA_RF, signal_quality: { ...(LORA_RF.signal_quality as Record<string, unknown>), adc_overdrive: true, state: 'OVERDRIVE', adc_overdrive_sources: ['detail'] } } as TelemetrySnapshot;
    expect(row(node(overdrive), 'ADC')).toEqual({ text: 'OVERDRIVE', className: 'is-bad' });
    expect(row(node(LORA_NAV), 'ADC')?.text).toBe('not available over Telemetry LoRa');
  });

  it('adds only the rows the edge sends', () => {
    const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('en', key, vars);
    expect(rfRows(null, t)).toEqual([]);
    expect(rfRows({ cfg: 1, centerHz: 103_100_000, vfo0Hz: null, gainDb: 12.5, bandwidthHz: null, squelchDb: null, ucaM: null }, t)).toEqual([]);
    expect(rfRows({ cfg: 1, centerHz: null, vfo0Hz: null, gainDb: null, bandwidthHz: 200_000, squelchDb: null, ucaM: null }, t)).toEqual([
      ['Bandwidth', '200 kHz · setting', undefined, true],
    ]);
  });

  it('keeps the Data Out values and adds the verified record for an answer without state.rf', () => {
    const live = node(LIVE);
    expect(live).toContain('433.920 MHz · gain 15.7 dB');
    expect(live).not.toContain('setting');
    expect(row(live, 'Center frequency')?.text).toBe('433.920 MHz');
    for (const label of ['VFO0', 'Bandwidth', 'Squelch']) expect(row(live, label)).toBeNull();
    expect(row(live, 'DoA signal')).toEqual({ text: '433.920 MHz · -54.2 dB', className: '' });
    const lora = node(LORA_NAV);
    expect(lora).toContain('Frequency and gain not available over Telemetry LoRa');
    expect(row(lora, 'VFO0')).toBeNull();
  });

  it('prefers the Data Out settings.json over state.rf', () => {
    const both = withRf(LIVE, { center_frequency_hz: 103_100_000, gain_db: 12.5, vfo0_frequency_hz: 103_100_000 });
    const markup = node(both);
    expect(row(markup, 'Center frequency')?.text).toBe('433.920 MHz');
    expect(row(markup, 'Gain')?.text).toBe('15.7 dB');
    expect(row(markup, 'VFO0')?.text).toBe('103.100 MHz · setting');
  });
});

describe('HUD line under the bearing', () => {
  it('names the frequency and power of the shown DoA', () => {
    const markup = hud(LIVE);
    expect(markup).toContain('<div class="ov-hud-sample">Signal <b>433.920 MHz · -54.2 dB</b></div>');
  });

  it('shows the UNVERIFIED record dimmed with the held bearing', () => {
    const markup = hud(LORA_RF);
    expect(markup).toContain('ov-hud-bearing is-provisional');
    expect(markup).toContain('<div class="ov-hud-sample is-provisional">Signal <b>103.100 MHz · -54.2 dB</b></div>');
    expect(markup).not.toContain('<div class="ov-hud-sample">');
    expect(hud(LORA_RF, 'id')).toContain('Sinyal <b>103.100 MHz · -54.2 dB</b>');
  });

  it('names the configured frequency as a setting when no record is current', () => {
    const noSample = withUnverified(LORA_RF, { stale: true });
    expect(hud(noSample)).toContain('<div class="ov-hud-sample is-setting">Setting <b>103.100 MHz</b></div>');
    // An expired answer's setting is not shown as current.
    expect(hud(LORA_RF, 'en', false)).not.toContain('Setting <b>');
    expect(hud(LORA_NAV)).not.toContain('Setting <b>');
    expect(hud(withRf(noSample, null))).not.toContain('ov-hud-sample');
  });
});

describe('Spectrum dock node frequency from state.rf', () => {
  it('uses the configured centre and VFO0 when nothing else names them', () => {
    expect(nodeFrequencies(LORA_RF, true)).toEqual({ centerHz: 103_100_000, vfoHz: 103_100_000 });
    const split = withRf(LORA_RF, { center_frequency_hz: 103_000_000, vfo0_frequency_hz: 103_250_000 });
    expect(nodeFrequencies(split, true)).toEqual({ centerHz: 103_000_000, vfoHz: 103_250_000 });
    expect(nodeFrequencies(withRf(LORA_RF, { center_frequency_hz: 103_000_000 }), true)).toEqual({ centerHz: 103_000_000, vfoHz: 103_000_000 });
    expect(nodeFrequencies(LORA_RF, false)).toBeNull();
  });

  it('never takes the UNVERIFIED record and keeps settings.json and the LIVE DoA first', () => {
    const other = withUnverified(withRf(LORA_RF, { center_frequency_hz: 103_000_000 }), { f: 145_500_000 });
    expect(nodeFrequencies(other, true)).toEqual({ centerHz: 103_000_000, vfoHz: 103_000_000 });
    expect(nodeFrequencies(withRf(LORA_RF, null), true)).toBeNull();
    expect(nodeFrequencies(withRf(LIVE, { center_frequency_hz: 103_100_000, vfo0_frequency_hz: 103_100_000 }), true)).toEqual({ centerHz: 433_920_000, vfoHz: 433_920_000 });
  });

  it('pairs the state.rf VFO only with the centre it was set with', () => {
    // A light read's settings.json (433.92 MHz) next to a newer state.rf after a retune to 145 MHz.
    const newer = withRf(UNVERIFIED, { center_frequency_hz: 145_000_000, vfo0_frequency_hz: 145_000_000 });
    expect(nodeFrequencies(newer, true)).toEqual({ centerHz: 433_920_000, vfoHz: 433_920_000 });
    const same = withRf(UNVERIFIED, { center_frequency_hz: 433_920_000, vfo0_frequency_hz: 434_000_000 });
    expect(nodeFrequencies(same, true)).toEqual({ centerHz: 433_920_000, vfoHz: 434_000_000 });
  });

  it('leaves out a power at the DOA_value.html floor of the UNVERIFIED record', () => {
    const status = (snapshot: TelemetrySnapshot) => overviewDoaStatus(snapshot, true);
    const floor = withUnverified(LORA_RF, { p: -100 });
    expect(doaSample(floor, status(floor), true)).toEqual({ frequencyHz: 103_100_000, powerDb: null, verified: false });
    const above = withUnverified(LORA_RF, { p: -97.06 });
    expect(doaSample(above, status(above), true)?.powerDb).toBe(-97.06);
  });
});

describe('ADC overdrive from health/detail', () => {
  it('reads the detail source and names it', () => {
    expect(signalQualityView(LORA_RF)).toMatchObject({ state: 'PASS', adcOverdrive: false, reportedBy: ['detail'] });
    expect(overdriveSourceFile('detail')).toBe('health/detail');
  });

  it('shows the edge verdict on System Health over Telemetry LoRa', () => {
    const markup = render(<SystemHealthPage snapshot={LORA_RF} mqtt={LORA_MQTT} localSnapshotFresh />);
    expect(markup).toMatch(/ADC.*PASS.*health\/detail/s);
    for (const text of ['>SNR<', '>PAPR<']) expect(markup).not.toContain(text);
    const unknown = render(<SystemHealthPage snapshot={LORA_NAV} mqtt={LORA_MQTT} localSnapshotFresh />);
    expect(unknown).toContain('not available over Telemetry LoRa');
    expect(unknown).not.toContain('health/detail');
  });

  it('shows ovr in Message Monitor', () => {
    const body = read('rdf-node/api-snapshot.json');
    body.node.detail.ovr = false;
    body.topics['telemetry/health/detail'].payload.ovr = true;
    const snapshot = normalizeRdfNodeSnapshot(body, body.now_ms);
    expect(snapshot.node.parts.detail?.fields.ovr).toBe(false);
    const markup = render(<RdfNodeView rdfNode={snapshot} rdfError={null} nowMs={body.now_ms} lora={false} />);
    expect(markup).toContain('ovr false');
    expect(markup).toContain('ovr true');
  });
});
