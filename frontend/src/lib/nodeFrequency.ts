/**
 * The SDR-DoA node's tuning, as the Overview spectrum dock follows it
 * ("Ikuti frekuensi node"). Read only from a fresh Data Out snapshot: the
 * centre is settings.json `center_freq` (MHz), the VFO is the CSV view's
 * `frequency_hz_normalized`, falling back to the centre. MQTT config_reported
 * is not used here; Kontrol reads that.
 */
import type { TelemetrySnapshot } from '../types';

export interface NodeFrequencies {
  centerHz: number;
  vfoHz: number;
}

/** Lowest and highest frequency accepted from the node (1 MHz to 6 GHz). */
const MIN_HZ = 1_000_000;
const MAX_HZ = 6_000_000_000;

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validHz(value: number | null): number | null {
  if (value === null) return null;
  const hz = Math.round(value);
  return hz >= MIN_HZ && hz <= MAX_HZ ? hz : null;
}

/** null unless the snapshot is fresh, reachable and reports a valid centre frequency. */
export function nodeFrequencies(snapshot: TelemetrySnapshot | null, localFresh: boolean): NodeFrequencies | null {
  if (!snapshot || !localFresh || snapshot.status?.available !== true || snapshot.simulation === true) return null;
  const fields = snapshot.settings?.fields;
  const centerMhz = fields && typeof fields === 'object' ? numeric((fields as Record<string, unknown>).center_freq) : null;
  const centerHz = validHz(centerMhz === null ? null : centerMhz * 1e6);
  if (centerHz === null) return null;
  const csv = snapshot.doa_candidates?.csv;
  const vfoHz = csv && csv.available !== false ? validHz(numeric(csv.frequency_hz_normalized)) : null;
  return { centerHz, vfoHz: vfoHz ?? centerHz };
}

/** True when both frequencies moved by more than `toleranceHz` (or one side is missing). */
export function nodeFrequenciesChanged(previous: NodeFrequencies | null, next: NodeFrequencies | null, toleranceHz = 1_000): boolean {
  if (!previous || !next) return previous !== next;
  return Math.abs(previous.centerHz - next.centerHz) > toleranceHz || Math.abs(previous.vfoHz - next.vfoHz) > toleranceHz;
}
