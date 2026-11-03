import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { DoaReadout } from '../components/DoaReadout';
import { vfoPeakRows } from '../components/overview/NodeCard';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { snapshotVfoPeak, vfoPeakText } from './telemetrySource';

// Edge contract 1.11 as the console reads it (tools/telemetry_source.py _vfo_peak): the output VFO's
// peak and the squelch rdfsdr held it against (health pk/psq), also while squelch holds DoA back.

/** An answer of tools/telemetry_source.py, written by tools/test_telemetry_source.py. */
function answer(name: string): TelemetrySnapshot {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/telemetry-source/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text) as TelemetrySnapshot;
}

function hud(snapshot: TelemetrySnapshot, lang: Lang = 'en', fresh = true): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <DoaReadout snapshot={snapshot} localSnapshotFresh={fresh} settings={{ figType: 'Compass', compassOffset: 0 }} offsetSource="FALLBACK" offsetVerified={false} />
    </I18nContext.Provider> as JSX.Element,
  );
}

const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);

function withPeak(peak: Record<string, unknown> | null): TelemetrySnapshot {
  return { ...answer('mqtt-lora-vfo-peak.json'), vfo_peak: peak } as TelemetrySnapshot;
}

describe('the VFO peak against squelch', () => {
  it('reads the server answer: 8.4 dB under squelch', () => {
    const peak = snapshotVfoPeak(answer('mqtt-lora-vfo-peak.json'));
    expect(peak).toEqual({ fresh: true, peakDb: -78.4, squelchDb: -70, marginDb: -8.4 });
    expect(vfoPeakText(peak!)).toBe('-78.4 dB · SQ -70.0 dB (-8.4)');
  });

  it('is absent from an edge before 1.11 and from Data Out answers', () => {
    expect(snapshotVfoPeak(answer('mqtt-lora-held.json'))).toBeNull();
    expect(snapshotVfoPeak(withPeak(null))).toBeNull();
  });

  it('carries no number unless the health and the edge reading are fresh', () => {
    const base = answer('mqtt-lora-vfo-peak.json').vfo_peak as Record<string, unknown>;
    expect(snapshotVfoPeak(withPeak({ ...base, fresh: false }))).toEqual({ fresh: false, peakDb: null, squelchDb: null, marginDb: null });
    expect(snapshotVfoPeak(withPeak({ ...base, peak_db: null }))?.fresh).toBe(false);
  });

  it('shows a positive margin with a plus and the peak alone without a level', () => {
    const base = answer('mqtt-lora-vfo-peak.json').vfo_peak as Record<string, unknown>;
    expect(vfoPeakText(snapshotVfoPeak(withPeak({ ...base, peak_db: -61 }))!)).toBe('-61.0 dB · SQ -70.0 dB (+9.0)');
    expect(vfoPeakText(snapshotVfoPeak(withPeak({ ...base, squelch_db: null }))!)).toBe('-78.4 dB');
  });

  it('is a node row: amber under squelch, green above, no tone at squelch, no number when stale', () => {
    const base = answer('mqtt-lora-vfo-peak.json').vfo_peak as Record<string, unknown>;
    expect(vfoPeakRows(snapshotVfoPeak(withPeak(base)), en)).toEqual([['VFO peak', '-78.4 dB · SQ -70.0 dB (-8.4)', 'is-warn', true]]);
    expect(vfoPeakRows(snapshotVfoPeak(withPeak({ ...base, peak_db: -61 })), en)[0][2]).toBe('is-good');
    // rdfsdr compares unrounded values: at 0.0 dB the side is unknown.
    expect(vfoPeakRows(snapshotVfoPeak(withPeak({ ...base, peak_db: -70 })), en)[0][2]).toBeUndefined();
    expect(hud(withPeak({ ...base, peak_db: -70 }))).not.toContain('below squelch');
    expect(vfoPeakRows(snapshotVfoPeak(withPeak({ ...base, fresh: false })), en)).toEqual([['VFO peak', 'no fresh reading', 'is-provisional', true]]);
    expect(vfoPeakRows(null, en)).toEqual([]);
  });

  it('is on the HUD while no DoA is shown, named as under squelch', () => {
    const html = hud(answer('mqtt-lora-vfo-peak.json'));
    expect(html).toContain('VFO peak <b>-78.4 dB · SQ -70.0 dB (-8.4)</b> · below squelch');
    expect(html).toContain('ov-hud-sample is-warn');
    expect(hud(answer('mqtt-lora-vfo-peak.json'), 'id')).toContain('Puncak VFO <b>-78.4 dB · SQ -70.0 dB (-8.4)</b> · di bawah squelch');
  });

  it('is not on the HUD once the local window has closed', () => {
    expect(hud(answer('mqtt-lora-vfo-peak.json'), 'en', false)).not.toContain('VFO peak');
  });
});
