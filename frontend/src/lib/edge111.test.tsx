import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeCapabilities, normalizeConfigReported } from '../api';
import type { ConfigReported } from '../api';
import { DoaReadout } from '../components/DoaReadout';
import { ControlPanelView } from '../components/overview/ControlPanel';
import type { ControlPanelViewProps } from '../components/overview/ControlPanel';
import { peakRows } from '../components/overview/NodeCard';
import type { TelemetrySnapshot } from '../types';
import { GAIN_TABLE_DB, configPatchFieldsFor, draftFromReported, parseDraft } from './configPatch';
import type { DraftValues } from './configPatch';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { controlAssist, vfoPeak } from './vfoPeak';
import type { VfoPeak } from './vfoPeak';

// Edge 1.11.0 (contract 1.11): telemetry/health carries pk (the output VFO's FFT peak) and psq (the squelch it
// was held against), also while the squelch holds DoA back. Measured on 2026-11-05 with the transmitter on
// near the RDF-SDR: a median peak of -79.7 dB under a Manual squelch of -70 dB, so DoA came only in bursts.

const POLAR = { figType: 'Compass', compassOffset: 0 } as const;
const HELD: VfoPeak = { peakDb: -79.7, squelchDb: -70, marginDb: -9.7, held: true };
const OPEN: VfoPeak = { peakDb: -53.4, squelchDb: -70, marginDb: 16.6, held: false };

const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
const id = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('id', key, vars);

function wrap(lang: Lang, node: JSX.Element): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: noop, t: (key, vars) => translate(lang, key, vars) }}>{node}</I18nContext.Provider>,
  );
}

/** An MQTT answer over LoRa whose node sends health with pk and psq but no fresh DoA. */
function heldAnswer(pk: number | null, psq: number | null): TelemetrySnapshot {
  return {
    overall_state: 'STALE',
    source: { kind: 'mqtt', reason: 'MQTT_FRESH', reasons: ['MQTT_FRESH'], link: 'lora' },
    doa_candidates: { mqtt: { available: false, error: 'no LIVE telemetry/doa (ok=1) in this session' } },
    mqtt: { health: { fresh: true, daq: 1, run: 1, why: ['NO_FRESH_DOA', 'DOA_FILE_NOT_UPDATING'], pk, psq } },
  } as unknown as TelemetrySnapshot;
}

describe('the HUD while squelch holds the DoA', () => {
  const hud = (snapshot: TelemetrySnapshot, lang: Lang = 'en') => wrap(lang, (
    <DoaReadout snapshot={snapshot} localSnapshotFresh settings={POLAR} offsetSource="NODE_HEADING" offsetVerified />
  ));

  it('names the peak and how far it is under the squelch', () => {
    const markup = hud(heldAnswer(-79.7, -70));
    expect(markup).toContain('VFO0 peak <b>-79.7 dB</b>');
    expect(markup).toContain('Squelch holds the DoA: signal 9.7 dB under the squelch');
    expect(hud(heldAnswer(-79.7, -70), 'id')).toContain('Squelch menahan DoA: sinyal 9.7 dB di bawah squelch');
  });

  it('shows the peak without the squelch note while it is above the squelch, and nothing from an older edge', () => {
    const open = hud(heldAnswer(-53.4, -70));
    expect(open).toContain('VFO0 peak <b>-53.4 dB</b>');
    expect(open).not.toContain('Squelch holds');
    expect(hud(heldAnswer(null, null))).not.toContain('VFO0 peak');
  });
});

describe('the node card row', () => {
  it('shows peak and squelch, marked when the squelch holds the DoA', () => {
    expect(peakRows(HELD, en)).toEqual([['VFO0 peak / SQ', '-79.7 / -70.0 dB', 'is-warn', true]]);
    expect(peakRows(OPEN, id)).toEqual([['Puncak VFO0 / SQ', '-53.4 / -70.0 dB', undefined, true]]);
    expect(peakRows({ peakDb: -80, squelchDb: null, marginDb: null, held: false }, en)).toEqual([['VFO0 peak / SQ', '-80.0 / — dB', undefined, true]]);
    expect(peakRows(null, en)).toEqual([]);
  });
});

const EDGE_19 = ['ant_spacing_m', 'center_frequency_hz', 'gain_db', 'vfo0_bandwidth_hz', 'vfo0_frequency_hz', 'vfo0_squelch_db', 'vfo0_squelch_mode'];
const FIELDS = configPatchFieldsFor(EDGE_19);
const VALUES = {
  center_frequency_hz: 400_919_000, gain_db: 15.7, vfo0_frequency_hz: 400_919_000, vfo0_bandwidth_hz: 12_500,
  vfo0_squelch_db: -70, ant_spacing_m: 0.128, vfo0_squelch_mode: 'Manual',
};
const evaluate = (draft: DraftValues = {}) => parseDraft(FIELDS, { ...draftFromReported(VALUES, FIELDS), ...draft }, VALUES, null);

describe('controlAssist', () => {
  it('offers a squelch 6 dB under the peak and the next gain 3 dB up while the squelch holds the DoA', () => {
    expect(controlAssist(HELD, evaluate().fields, GAIN_TABLE_DB)).toEqual({ peak: HELD, squelchDb: -86, gainDb: 19.7 });
  });

  it('follows the draft: a gain already raised steps on, a squelch already there is not offered again', () => {
    expect(controlAssist(HELD, evaluate({ gain_db: '19.7', vfo0_squelch_db: '-86' }).fields, GAIN_TABLE_DB))
      .toEqual({ peak: HELD, squelchDb: null, gainDb: 22.9 });
  });

  it('offers nothing while the peak is above the squelch, without a peak, or for fields the node does not take', () => {
    expect(controlAssist(OPEN, evaluate().fields, GAIN_TABLE_DB)).toBeNull();
    expect(controlAssist(null, evaluate().fields, GAIN_TABLE_DB)).toBeNull();
    expect(controlAssist(HELD, evaluate({ gain_db: '49.6' }).fields.filter((entry) => entry.field.key !== 'vfo0_squelch_db'), GAIN_TABLE_DB)).toBeNull();
  });

  it('reads the same as vfoPeak of the answer', () => {
    expect(vfoPeak(heldAnswer(-79.7, -70), true)).toEqual(HELD);
  });
});

describe('Kontrol with an edge 1.11 node', () => {
  const CAPABILITIES = normalizeCapabilities({ admin_enabled: true, config_patch: { enabled: true, requires_admin: true } });
  const reported: ConfigReported = normalizeConfigReported({
    available: true,
    broker: { host: '127.0.0.1', port: 9001, transport: 'websockets', connection: 'connected' },
    node: { sid: 'ac558386', cfg: 383, health_fresh: true, health_age_ms: 900, remote_commands: true, remote_config_patch: true, config_fields: EDGE_19 },
    base_rev: 383,
    settings: { id: 'gc-get-1', rev: 383, received_at_ms: 99_000, age_ms: 1200, matches_state_cfg: true },
    values: VALUES,
  });

  function view(peak: VfoPeak | null, lang: Lang = 'en', props: Partial<ControlPanelViewProps> = {}): string {
    const noop = () => undefined;
    return wrap(lang, (
      <ControlPanelView
        capabilities={CAPABILITIES} admin="unlocked" adminNotice={null} reported={reported} reportedError={null}
        evaluation={evaluate()} stage="edit" review={null} sending={null} done={null} editError={null} peak={peak}
        onClose={noop} onLock={noop} onUnlocked={noop} onDraftChange={noop} onReview={noop} onReset={noop}
        onSend={noop} onBack={noop} onDone={noop} onReload={noop}
        {...props}
      />
    ));
  }

  it('shows the peak, the squelch and the two fills under the fields', () => {
    const markup = view(HELD);
    expect(markup).toContain('VFO0 peak -79.7 dB · squelch -70.0 dB');
    expect(markup).toContain('Squelch holds the DoA.');
    expect(markup).toContain('>Squelch → -86 dB</button>');
    expect(markup).toContain('>Gain → 19.7 dB</button>');
    expect(markup).toContain('Use while the transmitter is on');
    expect(view(HELD, 'id')).toContain('Pakai saat pemancar menyala');
  });

  it('shows nothing of it while the peak is above the squelch or the node sends no peak', () => {
    expect(view(OPEN)).not.toContain('Squelch →');
    expect(view(null)).not.toContain('VFO0 peak');
  });

  it('only fills the form', () => {
    // The buttons are plain buttons in the edit step; Review and Send stay the operator's steps.
    const markup = view(HELD);
    expect(markup.match(/class="ov-button ov-control-assist-button"/g)).toHaveLength(2);
    expect(view(HELD, 'en', { stage: 'review' })).not.toContain('Squelch →');
  });
});
