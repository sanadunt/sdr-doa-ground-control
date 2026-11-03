import type { JSX } from 'react';
import type { MapCoordinate, TelemetrySnapshot } from '../../types';
import { adcOverdriven, daqSyncState, numberOrNull, syncCount } from '../../lib/telemetry';
import { signalQualityView } from '../../lib/healthView';
import { overviewDoaStatus } from '../../lib/doaStatus';
import { useI18n } from '../../lib/i18n';
import type { Translate } from '../../lib/i18n';
import { doaSample, doaSampleText, loraLink, overLora, snapshotNav, snapshotRf, snapshotVfoPeak, vfoPeakText, type VfoPeak } from '../../lib/telemetrySource';
import type { RfSettings } from '../../lib/telemetrySource';
import { engineSquelchDb } from '../../lib/configPatch';
import { distanceAndBearing, groundGpsState, groundGpsSummary, snapshotGroundGps, stationPositionLive } from '../../lib/groundGps';
import type { GeoOrigin } from '../../lib/doaGeometry';
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function navState(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z_]{1,16}$/u.test(value) ? value : null;
}

/**
 * The RDF-SDR's compass and GPS from the nav fields of health (contract 1.6),
 * shown only when the edge sends them. The heading is the compass's own value
 * (magnetic north plus the edge's offset); the bearing on the map does not use it.
 */
export function navRows(nav: Record<string, unknown> | null, t: Translate): Array<[string, string, string?]> {
  if (!nav) return [];
  const rows: Array<[string, string, string?]> = [];
  const compass = navState(nav.compass_state);
  const heading = finiteNumber(nav.heading_deg);
  if (compass !== null || heading !== null) {
    const text = heading !== null && compass === 'OK' ? `${heading.toFixed(1)}°` : compass ?? '—';
    rows.push([t('node.compass'), text, compass === 'OK' ? 'is-good' : compass ? 'is-warn' : undefined]);
  }
  const gps = navState(nav.gps_state);
  if (gps !== null) {
    const fix = finiteNumber(nav.fix);
    const sats = finiteNumber(nav.satellites);
    const parts = [gps === 'FIX' && (fix === 2 || fix === 3) ? `FIX ${fix}D` : gps];
    if (sats !== null) parts.push(t('node.satellites', { count: sats }));
    rows.push([t('node.gps'), parts.join(' · '), gps === 'FIX' ? 'is-good' : 'is-warn']);
  }
  const altitude = finiteNumber(nav.altitude_m);
  if (altitude !== null) rows.push([t('node.altitude'), `${altitude.toFixed(1)} m`]);
  const speed = finiteNumber(nav.speed_mps);
  if (speed !== null) rows.push([t('node.speed'), `${speed.toFixed(1)} m/s`]);
  return rows;
}

/** One detail row: label, value text, value class, and whether it spans both columns. */
type NodeRow = [string, string, string?, boolean?];

/**
 * VFO0, bandwidth and squelch of state.rf (edge 1.7), the UCA radius (edge
 * 1.8) and the squelch mode (edge 1.9), each only when the edge sends it, and
 * marked as a setting: settings.json of revision cfg, not a measurement. The
 * edge leaves rf.sq out exactly while the squelch is automatic, so a level
 * shows whenever it is sent: on a 1.9 node in whole dB as rdfsdr runs it
 * (int(), truncated toward zero), on an older one with a decimal as before.
 * Without a level, a mode other than Manual shows instead (AUTO, AUTO
 * CHANNEL, DEFAULT).
 */
export function rfRows(rf: RfSettings | null, t: Translate): NodeRow[] {
  if (!rf) return [];
  const setting = (value: string) => t('node.settingValue', { value });
  const rows: NodeRow[] = [];
  if (rf.vfo0Hz !== null) rows.push([t('node.vfo0'), setting(`${(rf.vfo0Hz / 1e6).toFixed(3)} MHz`), undefined, true]);
  if (rf.bandwidthHz !== null) rows.push([t('node.bandwidth'), setting(`${Number((rf.bandwidthHz / 1000).toFixed(1))} kHz`), undefined, true]);
  const mode = rf.squelchMode ?? null;
  if (rf.squelchDb !== null) {
    const level = mode === null ? rf.squelchDb.toFixed(1) : String(engineSquelchDb(rf.squelchDb));
    rows.push([t('node.squelch'), setting(`${level} dB`), undefined, true]);
  } else if (mode !== null && mode !== 'Manual') rows.push([t('node.squelch'), setting(mode.toUpperCase()), undefined, true]);
  if (rf.ucaM !== null) rows.push([t('node.uca'), setting(`${rf.ucaM.toFixed(3)} m`), undefined, true]);
  return rows;
}

/**
 * The output VFO's peak against squelch (edge 1.11 health pk/psq), measured
 * also while squelch holds DoA back: amber under squelch, green above it,
 * no tone at 0.0 dB (rdfsdr compares unrounded values). A reading that is
 * not fresh shows no number.
 */
export function vfoPeakRows(peak: VfoPeak | null, t: Translate): NodeRow[] {
  if (!peak) return [];
  if (!peak.fresh) return [[t('node.vfoPeak'), t('node.vfoPeakStale'), 'is-provisional', true]];
  const tone = peak.marginDb === null || peak.marginDb === 0 ? undefined : peak.marginDb > 0 ? 'is-good' : 'is-warn';
  return [[t('node.vfoPeak'), vfoPeakText(peak), tone, true]];
}

/**
 * The Groundstation row: its own GPS (ground-gps-publisher), with the distance
 * to the RDF-SDR while both positions are known. None from a console or an
 * answer without the ground_gps block, or while nothing reported.
 */
export function groundRow(
  snapshot: TelemetrySnapshot | null,
  localSnapshotFresh: boolean,
  ground: GeoOrigin | null,
  coordinate: MapCoordinate | null,
  positionHeld: boolean,
  t: Translate,
): NodeRow[] {
  const view = snapshotGroundGps(snapshot);
  if (!view?.present) return [];
  const state = groundGpsState(view, localSnapshotFresh);
  const distance = state === 'FIX' && ground && coordinate
    ? { distanceM: distanceAndBearing(ground, coordinate).distanceM, live: stationPositionLive(coordinate, positionHeld) }
    : null;
  const tone = state === 'FIX' ? 'is-good' : state === 'NO_DEVICE' || state === 'ERROR' ? 'is-bad' : undefined;
  return [[t('node.ground'), groundGpsSummary(view, state, distance, t), tone, true]];
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
  ground = null,
  groundGpsFresh,
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
  /** The groundstation's own GPS fix, for the distance to the RDF-SDR. */
  ground?: GeoOrigin | null;
  /** The groundstation GPS is current, apart from the RDF-SDR's data. */
  groundGpsFresh?: boolean;
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
  // Over the LoRa serial link there is no Data Out: settings, SNR and the ADC state cannot come, and are named so.
  const lora = overLora(snapshot);
  // Also without fresh MQTT: over the LoRa bridge Data Out is never the missing source.
  const link = loraLink(snapshot);
  const dataOutValue = (missing: boolean, text: string) => (lora && missing ? t('node.notOverLora') : value(text));
  // Without settings.json (over LoRa, or Data Out down) the edge's state.rf
  // names what the SDR is set to: shown, and marked as a setting.
  const rf = snapshotRf(snapshot);
  const rfCenterMhz = rf && rf.centerHz !== null ? rf.centerHz / 1e6 : null;
  const rfGainDb = rf?.gainDb ?? null;
  const rfSummary = summary.centerMhz === null && summary.gainDb === null && (rfCenterMhz !== null || rfGainDb !== null);
  const line1 = !snapshot
    ? t('node.waiting')
    : rfSummary && reachable
      ? t('node.summarySetting', { center: fmt(rfCenterMhz, 3), gain: fmt(rfGainDb, 1) })
      : lora && summary.centerMhz === null && summary.gainDb === null
        ? t('node.summaryLora')
        : reachable ? t('node.summary', { center: fmt(summary.centerMhz, 3), gain: fmt(summary.gainDb, 1) })
          : t(link ? 'node.noTelemetryLora' : 'node.unreachable');
  const setting = (text: string) => value(t('node.settingValue', { value: text }));
  const centerRow: NodeRow = summary.centerMhz === null && rfCenterMhz !== null
    ? [t('node.center'), setting(fmt(rfCenterMhz, 3, ' MHz')), undefined, true]
    : [t('node.center'), dataOutValue(summary.centerMhz === null, fmt(summary.centerMhz, 3, ' MHz'))];
  const gainRow: NodeRow = summary.gainDb === null && rfGainDb !== null
    ? [t('node.gain'), setting(fmt(rfGainDb, 1, ' dB')), undefined, true]
    : [t('node.gain'), dataOutValue(summary.gainDb === null, fmt(summary.gainDb, 1, ' dB'))];
  // The DoA record's frequency and power; an UNVERIFIED (ok=0) one is dimmed and named so.
  const sample = doaSample(snapshot, overviewDoaStatus(snapshot, localSnapshotFresh), localSnapshotFresh);
  const sampleRows: NodeRow[] = sample === null ? [] : [[
    t('node.sample'),
    value(sample.verified ? doaSampleText(sample) : `${doaSampleText(sample)} · UNVERIFIED`),
    sample.verified ? undefined : 'is-provisional',
    true,
  ]];
  const sourceLabel = coordinate ? t(positionHeld ? 'map.sourceHeld' : coordinateSourceKey(coordinate.source)) : null;
  const sourceTone = positionHeld || coordinate?.source === 'FALLBACK' ? 'is-warn' : coordinate?.source === 'MANUAL' ? 'is-manual' : undefined;
  const position = coordinate ? `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}` : t('readout.noPosition');
  // The Data Out host, frame index and settings.json's remote-control flag are Data Out only.
  const host = link ? null : dataOutHost(snapshot);
  const dataOutRows: NodeRow[] = link ? [] : [
    [t('node.frame'), value(summary.frame === null ? '—' : `#${summary.frame}`)],
    [t('node.remoteControl'), value(summary.remoteControl)],
  ];
  const rows: NodeRow[] = [
    centerRow,
    gainRow,
    ...rfRows(rf, t),
    ...(reachable ? vfoPeakRows(snapshotVfoPeak(snapshot), t) : []),
    ...sampleRows,
    [t('node.snr'), dataOutValue(summary.snrDb === null, fmt(summary.snrDb, 1, ' dB'))],
    [t('node.daq'), value(summary.daq), summary.daq.startsWith('PASS') ? 'is-good' : summary.daq.startsWith('FAIL') ? 'is-bad' : undefined],
    [t('node.adc'), dataOutValue(summary.adc === 'N/A', summary.adc), summary.adc === 'OK' ? 'is-good' : summary.adc === 'OVERDRIVE' ? 'is-bad' : undefined],
    ...dataOutRows,
    ...navRows(snapshotNav(snapshot), t),
    ...groundRow(snapshot, groundGpsFresh ?? localSnapshotFresh, ground, coordinate, positionHeld, t),
  ];

  return (
    <section id="panel-node" className="ov-node ov-card" aria-labelledby="ov-node-title">
      <div className="ov-card-head">
        <h2 id="ov-node-title">{t('node.title')}</h2>
        <span className={`ov-chip tone-${stateTone(state)}`}>{state}</span>
        <button className="ov-icon-button" type="button" aria-expanded={!collapsed} aria-controls="ov-node-detail" aria-label={collapsed ? t('node.expand') : t('node.collapse')} title={collapsed ? t('node.expand') : t('node.collapse')} onClick={onToggle}>
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} />
        </button>
      </div>
      <div className={values ? `ov-node-summary ${values}` : 'ov-node-summary'}>
        <span className={rfSummary && reachable ? 'is-setting' : undefined}>{line1}</span>
        <span title={t('node.position')}>{position}</span>
        {sourceLabel ? <span className={`ov-node-source ${sourceTone ?? ''}`}>{sourceLabel}</span> : null}
      </div>
      <div id="ov-node-detail" className="ov-node-detail" hidden={collapsed}>
        {host ? <div className="ov-node-host">{host}</div> : null}
        <dl className={values}>
          {rows.map(([label, text, tone, wide]) => (
            <div key={label} className={wide ? 'is-wide' : undefined}>
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
