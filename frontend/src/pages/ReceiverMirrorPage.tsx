import type { JSX } from 'react';
import { useI18n } from '../lib/i18n';
import type { Translate } from '../lib/i18n';
import type { MirrorState, MirrorView } from '../lib/receiverMirror';
import type { ReceiverMirrorFeed } from '../lib/receiverMirrorFeed';
import { formatMsps } from '../lib/radioSettings';
import { formatMhz, formatMhzTrim } from '../lib/spectrumView';
import { Card, KeyValueGrid, Page, PageGrid, PageHeader, PageNotice, StatusChip, Tag } from '../components/page';
import type { KeyValueItem } from '../components/page';
import { MirrorSpectrum, mirrorAge, mirrorChipText, mirrorMessage, useMirrorView } from '../components/overview/SpectrumDockMirror';

const DASH = '—';

function mhz(hz: number | null | undefined, digits = 3): string {
  return typeof hz === 'number' ? `${formatMhz(hz, digits)} MHz` : DASH;
}

function db(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Number(value.toFixed(1))} dB` : DASH;
}

function khz(hz: number | null | undefined): string {
  return typeof hz === 'number' ? `${Number((hz / 1e3).toFixed(2))} kHz` : DASH;
}

/** The mirrored Receiver state as label/value rows; codes stay untranslated. */
export function mirrorStateItems(t: Translate, view: MirrorView): KeyValueItem[] {
  const state: MirrorState | null = view.state;
  const vfo = state?.vfo ?? null;
  const scan = state?.scan ?? null;
  const scanRange = scan && scan.start_hz !== null && scan.stop_hz !== null
    ? ` · ${formatMhzTrim(scan.start_hz)}–${formatMhzTrim(scan.stop_hz)} MHz`
    : '';
  return [
    { id: 'source', label: t('mirror.sourceLabel'), value: view.source ? `${view.source.kind === 'engine-tab' ? t('mirror.sourceEngine') : t('mirror.sourceKiosk')}${view.source.visible ? '' : ' · HIDDEN'}` : DASH, mono: false },
    { id: 'seen', label: t('mirror.lastData'), value: mirrorAge(t, view.sourceAgeMs), tone: view.phase === 'lost' || view.phase === 'none' ? 'bad' : undefined },
    { id: 'frame', label: t('mirror.lastFrame'), value: mirrorAge(t, view.frameAgeMs), tone: view.phase === 'stale' ? 'warn' : undefined },
    { id: 'radio', label: 'RadioSpectrum', value: state ? (state.connected ? (state.mock ? 'MOCK' : 'CONNECTED') : 'NOT CONNECTED') : DASH },
    { id: 'rx', label: 'RX', value: state ? (state.running ? 'RUNNING' : 'STOPPED') : DASH, tone: state?.running ? 'good' : undefined },
    { id: 'recording', label: t('mirror.recording'), value: state ? (state.recording ? 'REC' : DASH) : DASH, tone: state?.recording ? 'bad' : undefined },
    { id: 'center', label: t('mirror.center'), value: mhz(state?.center_hz) },
    { id: 'rate', label: t('spectrum.sampleRate'), value: state?.sample_rate_hz ? `${formatMsps(state.sample_rate_hz)} MSPS` : DASH },
    { id: 'span', label: t('mirror.span'), value: mhz(state?.span_hz) },
    { id: 'shift', label: 'Freq Shift', value: state ? mhz(state.frequency_shift_hz) : DASH },
    { id: 'lna', label: 'LNA', value: db(state?.gains.lna_db) },
    { id: 'vga', label: 'VGA', value: db(state?.gains.vga_db) },
    { id: 'amp', label: t('spectrum.amp'), value: state ? (state.gains.amp ? 'ON' : 'OFF') : DASH },
    { id: 'vfo', label: 'VFO', value: vfo ? `${vfo.index + 1} · ${mhz(vfo.frequency_hz)}${vfo.enabled ? '' : ' · OFF'}` : DASH },
    { id: 'mode', label: t('spectrum.mode'), value: vfo?.mode ? vfo.mode.toUpperCase() : DASH },
    { id: 'bandwidth', label: t('mirror.bandwidth'), value: khz(vfo?.bandwidth_hz) },
    { id: 'squelch', label: t('mirror.squelch'), value: vfo ? (vfo.squelch_enabled ? db(vfo.squelch_db) : 'OFF') : DASH },
    { id: 'scan', label: t('mirror.scan'), value: scan ? `${scan.phase.toUpperCase()}${scanRange}` : DASH },
  ];
}

/**
 * The Receiver route in the LAN view: the groundstation's Receiver as the
 * console mirrors it, its state and its spectrum, view only and without
 * audio. The frame is never mounted here: the radio is on the
 * groundstation's USB.
 */
export function ReceiverMirrorPage({ feed }: { feed: ReceiverMirrorFeed }): JSX.Element {
  const { t } = useI18n();
  const view = useMirrorView(feed);
  // A notice only for what needs attention: no source, a lost source, stale frames, a stopped radio's error.
  const message = view.phase === 'lost' || view.phase === 'none' || view.phase === 'stale' || view.phase === 'stopped' ? mirrorMessage(t, view) : null;
  const noticeTone = view.tone === 'bad' ? 'bad' : view.tone === 'warn' ? 'warn' : 'info';
  return (
    <Page className="rx-mirror-page">
      <PageHeader
        title={t('route.receiver')}
        chips={<><Tag tone="info">MIRROR</Tag><StatusChip code={mirrorChipText(t, view)} tone={view.tone} /></>}
      />
      {message ? <PageNotice tone={noticeTone} title={mirrorChipText(t, view)}>{message}</PageNotice> : null}
      <PageGrid>
        <Card title={t('spectrum.title')} span={12} bodyClassName="rx-mirror-spectrum-body">
          <div className="ov-spectrum is-view-only is-mirror rx-mirror-spectrum">
            <div className="ov-spec-main">
              <MirrorSpectrum feed={feed} view={view} />
            </div>
          </div>
        </Card>
        <Card title={t('mirror.stateTitle')} span={12}>
          <KeyValueGrid items={mirrorStateItems(t, view)} columns={3} label={t('mirror.stateTitle')} />
        </Card>
      </PageGrid>
    </Page>
  );
}
