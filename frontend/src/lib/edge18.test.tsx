import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeCard, rfRows } from '../components/overview/NodeCard';
import type { TelemetrySnapshot } from '../types';
import { verifyConfigPatch } from './configVerify';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { resolveStationCoordinate } from './map';
import { snapshotRf } from './telemetrySource';

// Edge 1.8.0 (contract 1.8): state.rf.uca is the UCA radius (settings.json ant_spacing_meters),
// which tools/telemetry_source.py passes on as rf.uca_m.
type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
function read(path: string): Record<string, any> {
  return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/${path}`, import.meta.url), 'utf8'));
}

const LORA_RF = read('telemetry-source/mqtt-lora-rf.json') as TelemetrySnapshot;
const WITH_UCA = { ...LORA_RF, rf: { ...(LORA_RF.rf as Record<string, unknown>), uca_m: 0.3 } } as TelemetrySnapshot;

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function node(snapshot: TelemetrySnapshot, lang: Lang = 'en'): string {
  return render(<NodeCard snapshot={snapshot} localSnapshotFresh coordinate={resolveStationCoordinate(snapshot)} positionHeld={false} compassOffset={0} offsetSource="DATA_OUT" offsetManual={false} collapsed={false} onToggle={() => undefined} />, lang);
}

describe('state.rf.uca of an MQTT answer (edge 1.8)', () => {
  it('reads the UCA radius in metres, and none from an older edge', () => {
    expect(snapshotRf(WITH_UCA)?.ucaM).toBe(0.3);
    expect(snapshotRf(LORA_RF)?.ucaM).toBeNull();
    for (const bad of [0, -0.3, '0.3', Number.NaN, 1000]) {
      expect(snapshotRf({ ...WITH_UCA, rf: { ...(WITH_UCA.rf as Record<string, unknown>), uca_m: bad } } as TelemetrySnapshot)?.ucaM).toBeNull();
    }
    // The radius alone still makes a state.rf view.
    expect(snapshotRf({ ...LORA_RF, rf: { source: 'state.rf', uca_m: 0.128 } } as TelemetrySnapshot)?.ucaM).toBe(0.128);
  });

  it('shows UCA in the node card as a setting, only when the edge sends it', () => {
    const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('en', key, vars);
    const rf = { cfg: 1, centerHz: null, vfo0Hz: null, gainDb: null, bandwidthHz: null, squelchDb: null, ucaM: 0.128 };
    expect(rfRows(rf, t)).toEqual([['UCA', '0.128 m · setting', undefined, true]]);
    expect(rfRows({ ...rf, ucaM: null }, t)).toEqual([]);
    expect(node(WITH_UCA)).toContain('<dt>UCA</dt><dd>0.300 m · setting</dd>');
    expect(node(WITH_UCA, 'id')).toContain('<dt>UCA</dt><dd>0.300 m · setelan</dd>');
    expect(node(LORA_RF)).not.toContain('<dt>UCA</dt>');
  });
});

describe('the read-back of a sent UCA spacing', () => {
  const issued = 1_000;
  const reported = (value: number | null, at = 2_000) => ({
    values: { center_frequency_hz: null, gain_db: null, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null, ant_spacing_m: value },
    valueReceivedAtMs: { center_frequency_hz: null, gain_db: null, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null, ant_spacing_m: value === null ? null : at },
  });
  const check = (mqtt: number | null, dataOut: number | null = null) => verifyConfigPatch({
    changes: { ant_spacing_m: 0.3 },
    issuedAtMs: issued,
    finalAtMs: 3_000,
    nowMs: 200_000,
    reported: reported(mqtt),
    snapshot: dataOut === null ? null : { settings: { available: true, fields: { ant_spacing_meters: dataOut } } } as TelemetrySnapshot,
    snapshotFresh: true,
  });

  it('counts settings/reported within 0.5 mm', () => {
    expect(check(0.3).fields[0]).toMatchObject({ key: 'ant_spacing_m', basis: 'mqtt', status: 'confirmed' });
    expect(check(0.3004).fields[0].status).toBe('confirmed');
    expect(check(0.3006).fields[0].status).toBe('unchanged');
  });

  it('falls back to Data Out settings.json ant_spacing_meters', () => {
    expect(check(null, 0.3).fields[0]).toMatchObject({ basis: 'data-out', dataOut: 0.3, status: 'confirmed' });
    expect(check(null, 0.128).fields[0].status).toBe('unchanged');
    expect(check(null).fields[0].status).toBe('not-reported');
  });
});
