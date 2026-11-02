import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeCard } from '../components/overview/NodeCard';
import { DoADiagnosticsPage } from '../pages/DoADiagnosticsPage';
import { RdfNodeView } from '../pages/MessageMonitorPage';
import { compassCauseKey } from '../pages/OverviewPage';
import { SystemHealthPage } from '../pages/SystemHealthPage';
import type { MqttSnapshot, TelemetrySnapshot } from '../types';
import { deliveryView } from './delivery';
import { rankGateReasons } from './doaStatus';
import { I18nContext, gateReasonLabel, translate } from './i18n';
import type { Lang } from './i18n';
import { normalizeLoraLink } from './loraLink';
import { resolveStationCoordinate } from './map';
import { normalizeRdfNodeSnapshot } from './mqttMonitor';

type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
function read(path: string): Record<string, any> {
  return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/${path}`, import.meta.url), 'utf8'));
}

// Answers of tools/telemetry_source.py: over the LoRa serial bridge, and over MQTT with Data Out as the fallback.
const LORA = read('telemetry-source/mqtt-lora-nav.json') as TelemetrySnapshot;
const LIVE = read('telemetry-source/mqtt-live.json') as TelemetrySnapshot;
const LORA_MQTT: MqttSnapshot = { connection: 'connected', lora: normalizeLoraLink(read('lora-link/views.json').receiving) };

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function node(snapshot: TelemetrySnapshot): string {
  return render(<NodeCard snapshot={snapshot} localSnapshotFresh coordinate={resolveStationCoordinate(snapshot)} positionHeld={false} compassOffset={0} offsetSource="DATA_OUT" offsetManual={false} collapsed={false} onToggle={() => undefined} />);
}

describe('pages over Telemetry LoRa name nothing of Data Out or PPP', () => {
  it('treats the unknown overdrive as a property of the link, not a data problem', () => {
    expect(LORA.publication_gate?.reasons).toContain('ADC_OVERDRIVE_NOT_OVER_LORA');
    expect(LORA.publication_gate?.reasons).not.toContain('ADC_OVERDRIVE_UNKNOWN');
    const delivery = deliveryView(LORA);
    expect(delivery.notes).toContain('ADC_OVERDRIVE_NOT_OVER_LORA');
    expect(delivery.problems).not.toContain('ADC_OVERDRIVE_NOT_OVER_LORA');
    expect(rankGateReasons(['ADC_OVERDRIVE_NOT_OVER_LORA', 'MQTT_NO_DOA'])[0]).toBe('MQTT_NO_DOA');
    expect(gateReasonLabel('en', 'ADC_OVERDRIVE_NOT_OVER_LORA')).toBe('ADC overdrive is not carried over Telemetry LoRa');
    expect(gateReasonLabel('id', 'ADC_OVERDRIVE_NOT_OVER_LORA')).toBe('ADC overdrive tidak dikirim lewat Telemetry LoRa');
  });

  it('leaves the Data Out host, frame index and remote-control flag out of the node card', () => {
    const lora = node(LORA);
    expect(lora).not.toContain('8081');
    expect(lora).not.toContain('DAQ frame');
    expect(lora).not.toContain('Remote control');
    const live = node(LIVE);
    expect(live).toContain('DAQ frame');
    expect(live).toContain('Remote control');
  });

  it('names the compass offset cause by the link', () => {
    expect(compassCauseKey('DATA_OUT_UNAVAILABLE', true)).toBe('map.orientationNotOverLora');
    expect(compassCauseKey('DATA_OUT_UNAVAILABLE')).toBe('map.orientationNotRead');
    expect(translate('id', 'map.orientationNotOverLora')).toBe('offset kompas tidak tersedia lewat Telemetry LoRa');
  });

  it('shows System Health without the Data Out HTTP chip, SNR, PAPR, frame index or noise source', () => {
    const lora = render(<SystemHealthPage snapshot={LORA} mqtt={LORA_MQTT} localSnapshotFresh />);
    for (const text of ['>HTTP<', '>SNR<', '>PAPR<', 'CSV / XML', 'Frame index', 'Noise source']) expect(lora).not.toContain(text);
    expect(lora).toContain('not available over Telemetry LoRa');
    // The GPS state is the one telemetry/health carries.
    expect(lora).toMatch(/GPS status<\/dt><dd[^>]*>FIX</);
    const live = render(<SystemHealthPage snapshot={LIVE} mqtt={{ connection: 'connected' }} localSnapshotFresh />);
    for (const text of ['>HTTP<', '>SNR<', '>PAPR<', 'Frame index', 'Noise source']) expect(live).toContain(text);
  });

  it('shows DoA Diagnostics without native views, settings.json or the Data Out fallback', () => {
    const lora = render(<DoADiagnosticsPage snapshot={LORA} localSnapshotFresh />);
    for (const text of ['Native views', 'Settings source', 'raw_settings_omitted', 'Data Out (fallback) not used', 'not read yet']) expect(lora).not.toContain(text);
    expect(lora).toContain('MQTT · Telemetry LoRa');
    expect(lora).toContain(translate('en', 'diag.configLora'));
    const live = render(<DoADiagnosticsPage snapshot={LIVE} localSnapshotFresh />);
    expect(live).toContain('Native views');
    expect(live).toContain('Data Out (fallback) not used');
  });

  it('drops the edge PPP fields from Message Monitor', () => {
    const body = read('rdf-node/api-snapshot.json');
    const ppp = { ppp: 'DOWN', peer: 'NO_INTERFACE', ppp_svc: 'INACTIVE', ppp_restarts: 0 };
    Object.assign(body.node.detail, ppp);
    Object.assign(body.topics['telemetry/health/detail'].payload, ppp);
    const snapshot = normalizeRdfNodeSnapshot(body, body.now_ms);
    const view = (lora: boolean) => render(<RdfNodeView rdfNode={snapshot} rdfError={null} nowMs={body.now_ms} lora={lora} />);
    expect(view(false)).toContain('ppp DOWN');
    expect(view(false)).toContain('ppp_svc INACTIVE');
    const lora = view(true);
    for (const text of ['ppp DOWN', 'peer NO_INTERFACE', 'ppp_svc', 'ppp_restarts']) expect(lora).not.toContain(text);
    expect(lora).toContain('cpu 23.5');
  });
});
