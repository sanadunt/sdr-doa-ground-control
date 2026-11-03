import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeConfigReported } from '../api';
import { ConfigurationPage } from '../pages/ConfigurationPage';
import { SystemHealthPage } from '../pages/SystemHealthPage';
import { DEFAULT_GPS_CONFIG } from './map';
import { DEFAULT_COMPASS_CONFIG } from './polar';
import type { LoraLinkView, MqttSnapshot, TelemetrySnapshot } from '../types';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { dataOutUnused, normalizeLoraLink } from './loraLink';
import { angularFrameAgeMs, snapshotSourceReasons } from './telemetrySource';

type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
function read(path: string): unknown {
  return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/${path}`, import.meta.url), 'utf8'));
}

const LORA_ANSWER = read('telemetry-source/mqtt-lora-nav.json') as TelemetrySnapshot;
const LIVE_ANSWER = read('telemetry-source/mqtt-live.json') as TelemetrySnapshot;
const LORA_VIEW = normalizeLoraLink((read('lora-link/views.json') as Record<string, unknown>).receiving) as LoraLinkView;
const LORA_MQTT: MqttSnapshot = { connection: 'connected', fetched_at_ms: Date.now(), lora: LORA_VIEW };

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function configuration(mqtt: MqttSnapshot | null, lang: Lang = 'en'): string {
  return render(
    <ConfigurationPage
      config={{ base_url: 'http://10.90.0.2:8081', mqtt_host: 'localhost', mqtt_port: 9001, refresh_seconds: 2 }}
      branding={{ app_name: 'Ground Console', logo_data_url: '' }}
      gpsConfig={DEFAULT_GPS_CONFIG}
      compassConfig={DEFAULT_COMPASS_CONFIG}
      onGpsConfigChanged={() => undefined}
      onCompassConfigChanged={() => undefined}
      onConfigSaved={async () => undefined}
      onBrandingChanged={() => undefined}
      mqtt={mqtt}
    />,
    lang,
  );
}

describe('Data Out while Telemetry LoRa carries the node', () => {
  it('is unused when the answer or the broker names the LoRa bridge', () => {
    expect(dataOutUnused(LORA_ANSWER, null)).toBe(true);
    expect(dataOutUnused(null, LORA_MQTT)).toBe(true);
    const none = { source: { kind: 'none', reasons: ['MQTT_HEALTH_STALE', 'DATA_OUT_NOT_OVER_LORA'], link: 'lora' } } as TelemetrySnapshot;
    expect(dataOutUnused(none, null)).toBe(true);
    expect(snapshotSourceReasons(none)).toEqual(['MQTT_HEALTH_STALE', 'DATA_OUT_NOT_OVER_LORA']);
    expect(translate('id', 'source.reason.DATA_OUT_NOT_OVER_LORA')).toBe('Data Out tidak dipakai lewat Telemetry LoRa');
    expect(dataOutUnused(LIVE_ANSWER, { connection: 'connected' })).toBe(false);
    expect(dataOutUnused(null, null)).toBe(false);
  });

  it('folds the Data Out settings away in Configuration and keeps the refresh interval', () => {
    const markup = configuration(LORA_MQTT);
    expect(markup).toContain('<details class="cfg-dataout-unused"><summary>Data Out · not used over Telemetry LoRa</summary>');
    expect(markup).toContain('http://10.90.0.2:8081');
    expect(markup.indexOf('cfg-dataout-unused')).toBeGreaterThan(markup.indexOf('pg-segmented'));
    expect(configuration(LORA_MQTT, 'id')).toContain('Data Out · tidak dipakai selama Telemetry LoRa');
    expect(configuration({ connection: 'connected' })).not.toContain('cfg-dataout-unused');
  });

  it('names the node source RDF-SDR in the GPS and Compass switches, the long name as its title', () => {
    const markup = configuration(LORA_MQTT, 'id');
    expect(markup.match(/<button type="button" aria-pressed="[a-z]+" title="RDF-SDR \(Telemetry LoRa\)">RDF-SDR<\/button>/g)).toHaveLength(2);
    const ip = configuration({ connection: 'connected' });
    expect(ip).toContain('<button type="button" aria-pressed="true">Data Out</button>');
    expect(ip).not.toContain('RDF-SDR (Telemetry LoRa)');
  });

  it('leaves the Data Out card out of System Health', () => {
    const health = (snapshot: TelemetrySnapshot, mqtt: MqttSnapshot | null) => render(<SystemHealthPage snapshot={snapshot} mqtt={mqtt} localSnapshotFresh />);
    const title = 'Data Out';
    expect(health(LORA_ANSWER, LORA_MQTT)).not.toContain(`>${title}<`);
    expect(health(LIVE_ANSWER, { connection: 'connected' })).toContain(`>${title}<`);
  });
});

describe('Kontrol over Telemetry LoRa', () => {
  it('reads the link from config-reported', () => {
    expect(normalizeConfigReported({ available: true, link: 'lora' }).link).toBe('lora');
    expect(normalizeConfigReported({ available: true, link: 'ppp' }).link).toBeNull();
    expect(normalizeConfigReported({ available: true }).link).toBeNull();
    expect(translate('id', 'control.loraWaiting')).toBe('Menunggu giliran radio Telemetry LoRa…');
  });
});

describe('Angular frame age', () => {
  it('comes from the MQTT answer only', () => {
    expect(angularFrameAgeMs(LIVE_ANSWER)).toBe(0);
    const old = structuredClone(LIVE_ANSWER) as TelemetrySnapshot & { doa_candidates: { mqtt: { angular_frame: { age_ms: number } } } };
    old.doa_candidates.mqtt.angular_frame.age_ms = 14_200;
    expect(angularFrameAgeMs(old)).toBe(14_200);
    expect(angularFrameAgeMs({ ...LIVE_ANSWER, source: { kind: 'data_out' } } as TelemetrySnapshot)).toBeNull();
    expect(translate('id', 'polarDock.angularAge', { age: '14 dtk' })).toBe('Angular 14 dtk lalu');
  });
});
