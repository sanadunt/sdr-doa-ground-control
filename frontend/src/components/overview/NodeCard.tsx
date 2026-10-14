import type { JSX } from 'react';
import type { MapCoordinate, TelemetrySnapshot } from '../../types';
import { adcOverdriven, daqSyncState, numberOrNull, syncCount } from '../../lib/telemetry';
import { signalQualityView } from '../../lib/healthView';
import { useI18n } from '../../lib/i18n';
import { coordinateSourceKey } from '../DoaReadout';
import { Icon } from '../ui';

type ChipTone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteField(fields: Record<string, unknown> | null, key: string): number | null {
  const value = fields?.[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Server states that only describe current data, so local expiry turns them into STALE. */
const STATES_SHOWN_STALE: ReadonlySet<string> = new Set(['LIVE', 'UNVERIFIED', 'INCOMPLETE']);

function stateTone(state: string): ChipTone {
  if (state === 'LIVE') return 'good';
  if (state === 'UNVERIFIED') return 'info';
  if (state === 'WAITING' || state === 'SIMULATION' || state === 'STALE' || state === 'INCOMPLETE' || state === 'DEGRADED') return 'warn';
  if (state === 'UNAVAILABLE' || state === 'INVALID' || state === 'CONFLICT' || state === 'ERROR') return 'bad';
  return 'neutral';
}

/** host:port of the Data Out URL the collector read, for orientation only. */
function dataOutHost(snapshot: TelemetrySnapshot | null): string | null {
  const baseUrl = recordOrNull(snapshot?.collector)?.base_url;
  if (typeof baseUrl !== 'string') return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

export interface NodeSummary {
  /** Center frequency in MHz from settings.json, or null. */
  centerMhz: number | null;
  gainDb: number | null;
  snrDb: number | null;
  daq: string;
  adc: string;
  frame: number | null;
  remoteControl: string;
}

/** Node values for the card, read only from the snapshot's validated sections. */
export function nodeSummary(snapshot: TelemetrySnapshot | null): NodeSummary {
  const fields = recordOrNull(snapshot?.settings?.fields);
  const daqStatus = recordOrNull(snapshot?.status?.safe?.daq_status);
  const quality = signalQualityView(snapshot);
  const sync = daqSyncState(snapshot);
  const remote = fields?.en_remote_control;
  const frame = numberOrNull(daqStatus?.data_frame_index);
  return {
    centerMhz: finiteField(fields, 'center_freq'),
    gainDb: finiteField(fields, 'uniform_gain'),
    snrDb: quality?.snrDb ?? null,
    daq: sync === null ? 'N/A' : `${sync} ${syncCount(snapshot)}/3`,
    adc: adcOverdriven(snapshot) || quality?.adcOverdrive === true ? 'OVERDRIVE' : quality?.adcOverdrive === false ? 'OK' : 'N/A',
    frame: frame !== null && Number.isInteger(frame) && frame >= 0 ? frame : null,
    remoteControl: remote === true ? 'ON' : remote === false ? 'OFF' : 'N/A',
  };
}

/**
 * Collapsible node card in the right column. The two summary lines always
 * render, including the station position, so the position stays visible
 * without opening the card.
 */
export function NodeCard({
  snapshot,
  localSnapshotFresh,
  coordinate,
  positionHeld,
  compassOffset,
  offsetSource,
  offsetManual,
  collapsed,
  onToggle,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  coordinate: MapCoordinate | null;
  positionHeld: boolean;
  compassOffset: number;
  offsetSource: string;
  offsetManual: boolean;
  collapsed: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const summary = nodeSummary(snapshot);
  // The server state describes the last read. Once the local window has
  // closed or a read failed, a state that reads as current data becomes STALE
  // like the top-bar DATA chip; UNAVAILABLE, INVALID, CONFLICT and DEGRADED
  // take precedence over STALE there too and are kept.
  const serverState = snapshot ? String(snapshot.overall_state ?? 'UNKNOWN').toUpperCase() : 'WAITING';
  const state = snapshot && !localSnapshotFresh && STATES_SHOWN_STALE.has(serverState) ? 'STALE' : serverState;
  const reachable = snapshot?.status?.available === true;
  const values = reachable && !localSnapshotFresh ? 'is-stale' : undefined;
  const fmt = (value: number | null, digits: number, unit = '') => (value === null ? '—' : `${value.toFixed(digits)}${unit}`);
  const value = (text: string) => (reachable ? text : '—');
  const line1 = !snapshot
    ? t('node.waiting')
    : reachable ? t('node.summary', { center: fmt(summary.centerMhz, 3), gain: fmt(summary.gainDb, 1) }) : t('node.unreachable');
  const sourceLabel = coordinate ? t(positionHeld ? 'map.sourceHeld' : coordinateSourceKey(coordinate.source)) : null;
  const sourceTone = positionHeld || coordinate?.source === 'FALLBACK' ? 'is-warn' : coordinate?.source === 'MANUAL' ? 'is-manual' : undefined;
  const position = coordinate ? `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}` : t('readout.noPosition');
  const host = dataOutHost(snapshot);
  const rows: Array<[string, string, string?]> = [
    [t('node.center'), value(fmt(summary.centerMhz, 3, ' MHz'))],
    [t('node.gain'), value(fmt(summary.gainDb, 1, ' dB'))],
    [t('node.snr'), value(fmt(summary.snrDb, 1, ' dB'))],
    [t('node.daq'), value(summary.daq), summary.daq.startsWith('PASS') ? 'is-good' : summary.daq.startsWith('FAIL') ? 'is-bad' : undefined],
    [t('node.adc'), value(summary.adc), summary.adc === 'OK' ? 'is-good' : summary.adc === 'OVERDRIVE' ? 'is-bad' : undefined],
    [t('node.frame'), value(summary.frame === null ? '—' : `#${summary.frame}`)],
    [t('node.remoteControl'), value(summary.remoteControl)],
  ];

  return (
    <section className="ov-node ov-card" aria-labelledby="ov-node-title">
      <div className="ov-card-head">
        <h2 id="ov-node-title">{t('node.title')}</h2>
        <span className={`ov-chip tone-${stateTone(state)}`}>{state}</span>
        <button className="ov-icon-button" type="button" aria-expanded={!collapsed} aria-controls="ov-node-detail" aria-label={collapsed ? t('node.expand') : t('node.collapse')} title={collapsed ? t('node.expand') : t('node.collapse')} onClick={onToggle}>
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} />
        </button>
      </div>
      <div className={values ? `ov-node-summary ${values}` : 'ov-node-summary'}>
        <span>{line1}</span>
        <span title={t('node.position')}>{position}</span>
        {sourceLabel ? <span className={`ov-node-source ${sourceTone ?? ''}`}>{sourceLabel}</span> : null}
      </div>
      <div id="ov-node-detail" className="ov-node-detail" hidden={collapsed}>
        {host ? <div className="ov-node-host">{host}</div> : null}
        <dl className={values}>
          {rows.map(([label, text, tone]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={tone}>{text}</dd>
            </div>
          ))}
        </dl>
        <div className="ov-node-foot">
          <span>{t('node.offset')} <b>{Number(compassOffset.toFixed(1))}°</b> · <span className={offsetManual ? 'is-manual' : undefined}>{offsetSource}</span></span>
        </div>
      </div>
    </section>
  );
}
