import type { TelemetrySnapshot } from '../types';
import type { FieldEvaluation } from './configPatch';
import { isMqttSnapshot } from './telemetrySource';

/**
 * The output VFO's peak against its squelch (contract 1.11 telemetry/health
 * pk and psq): the FFT peak inside VFO0's bandwidth on KrakenSDR's dB scale
 * (not dBm, it follows the gain) and the squelch it was compared with. rdfsdr
 * computes a DoA only while the peak is above the squelch, so a peak under it
 * tells a squelch set too high (or a transmitter that is off) from a fault.
 */
export interface VfoPeak {
  peakDb: number;
  squelchDb: number | null;
  /** peak − squelch, 0.1 dB; null without a squelch. */
  marginDb: number | null;
  /** The squelch holds DoA back: the peak is not above it. */
  held: boolean;
}

const LEVEL_LIMIT_DB = 300;

function level(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LEVEL_LIMIT_DB ? value : null;
}

/** The peak of a fresh health in a current MQTT answer; null from an older edge or while the edge's measurement is stale. */
export function vfoPeak(snapshot: TelemetrySnapshot | null | undefined, localSnapshotFresh: boolean): VfoPeak | null {
  if (!snapshot || snapshot.simulation === true || !localSnapshotFresh || !isMqttSnapshot(snapshot)) return null;
  const health = snapshot.mqtt?.health;
  if (health === null || typeof health !== 'object') return null;
  const record = health as Record<string, unknown>;
  if (record.fresh !== true) return null;
  const peakDb = level(record.pk);
  if (peakDb === null) return null;
  const squelchDb = level(record.psq);
  const marginDb = squelchDb === null ? null : Math.round((peakDb - squelchDb) * 10) / 10;
  return { peakDb, squelchDb, marginDb, held: marginDb !== null && marginDb <= 0 };
}

/** How far under the peak the suggested squelch goes. */
export const SQUELCH_ASSIST_MARGIN_DB = 6;
const SQUELCH_MIN_DB = -200;
const SQUELCH_MAX_DB = 50;

/** A squelch that lets the peak measured now through: 6 dB under it, in whole dB, inside the edge range. */
export function squelchFromPeak(peakDb: number): number {
  return Math.min(SQUELCH_MAX_DB, Math.max(SQUELCH_MIN_DB, Math.round(peakDb - SQUELCH_ASSIST_MARGIN_DB)));
}

/** The smallest gain raise the assist offers; the table's next steps are under 1 dB apart in places. */
export const GAIN_ASSIST_STEP_DB = 3;
const GAIN_TOLERANCE_DB = 0.001;

/** The first gain of the edge's table at least 3 dB above the current one, or null at its top. */
export function gainStepUp(currentDb: number | null, table: readonly number[]): number | null {
  if (currentDb === null || !Number.isFinite(currentDb)) return null;
  const next = [...table].sort((a, b) => a - b).find((gain) => gain >= currentDb + GAIN_ASSIST_STEP_DB - GAIN_TOLERANCE_DB);
  return next ?? null;
}

/** What Kontrol offers to fill while the squelch holds the DoA: a lower squelch, a higher gain, or null for each. */
export interface ControlAssist {
  peak: VfoPeak;
  squelchDb: number | null;
  gainDb: number | null;
}

/**
 * The fills for Kontrol's form, from the peak and the form's current values
 * (draft over reported). Only while the squelch holds the DoA, and only for
 * fields the node takes; a fill that equals the form's value is not offered.
 * They only fill the form: Review and Send stay the operator's steps.
 */
export function controlAssist(peak: VfoPeak | null, fields: readonly FieldEvaluation[], table: readonly number[]): ControlAssist | null {
  if (!peak?.held) return null;
  const entry = (key: string) => fields.find((field) => field.field.key === key);
  const squelch = entry('vfo0_squelch_db');
  const gain = entry('gain_db');
  const suggested = squelchFromPeak(peak.peakDb);
  const squelchDb = squelch && !(typeof squelch.value === 'number' && squelch.value === suggested && !squelch.locked) ? suggested : null;
  const gainDb = gain ? gainStepUp(typeof gain.value === 'number' ? gain.value : null, table) : null;
  if (squelchDb === null && gainDb === null) return null;
  return { peak, squelchDb, gainDb };
}
