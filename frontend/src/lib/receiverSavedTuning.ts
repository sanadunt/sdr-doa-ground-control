/**
 * The Receiver's last saved tuning, read from its SDRSetting entry (written by
 * the Receiver frame and copied to the console server like the other
 * preferences). The console only reads it, to show the centre and VFO in the
 * spectrum dock before the frame is mounted; it never writes it, because the
 * frame overwrites the entry at its next save.
 */
import { inTuneRange } from './receiverBridgeProtocol';

export const RECEIVER_SETTING_KEY = 'SDRSetting';
/** Larger entries are not parsed. */
export const RECEIVER_SETTING_MAX_CHARS = 64 * 1024;

export interface SavedReceiverTuning {
  centerHz: number;
  /** The active VFO, or null when the entry has none in range. */
  vfoHz: number | null;
}

type StorageLike = Pick<Storage, 'getItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mhzToTuneHz(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const hz = Math.round(value * 1e6);
  return inTuneRange(hz) ? hz : null;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The saved centre (MHz in the entry) in Hz, or null when it is missing, malformed or out of range. */
export function savedReceiverTuning(storage: StorageLike | null = defaultStorage()): SavedReceiverTuning | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(RECEIVER_SETTING_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || !raw || raw.length > RECEIVER_SETTING_MAX_CHARS) return null;
  let setting: unknown;
  try {
    setting = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(setting) || !isRecord(setting.radio)) return null;
  const centerHz = mhzToTuneHz(setting.radio.centerFreq);
  if (centerHz === null) return null;
  const vfos = Array.isArray(setting.vfos) ? setting.vfos : [];
  const index = typeof setting.activeVfoIndex === 'number' && Number.isInteger(setting.activeVfoIndex)
    && setting.activeVfoIndex >= 0 && setting.activeVfoIndex < vfos.length ? setting.activeVfoIndex : 0;
  const vfo: unknown = vfos[index];
  return { centerHz, vfoHz: isRecord(vfo) ? mhzToTuneHz(vfo.freq) : null };
}
