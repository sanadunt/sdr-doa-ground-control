/**
 * The Receiver's saved wide-scan settings, read from its ReceiverSweepSettings
 * entry (written by the Receiver frame and copied to the console server like
 * the other preferences). The Spektrum dock reads them only before the frame
 * is mounted, to draw the scan range and fill its Atur rows; it never writes
 * the entry. A value that is missing or that the Receiver would not restore
 * takes the Receiver's own default, as the Receiver itself does on load.
 */
import { DISPLAY_DB_LIMITS, SWEEP_LIMITS, SWEEP_SPAN_LIMITS, isSweepFftSize } from './receiverBridgeProtocol';
import type { SweepFftSize } from './receiverBridgeProtocol';
import { savedFrequencyShiftHz } from './receiverSavedTuning';

export const RECEIVER_SWEEP_SETTINGS_KEY = 'ReceiverSweepSettings';
/** Larger entries are not parsed. */
export const RECEIVER_SWEEP_SETTINGS_MAX_CHARS = 4 * 1024;

export interface SavedReceiverSweep {
  /** Displayed Hz: the saved device range plus the saved Freq Shift. */
  startHz: number;
  stopHz: number;
  fftSize: SweepFftSize;
  resolutionHz: number;
  lnaDb: number;
  vgaDb: number;
  amp: boolean;
  /** The Graph min./max. */
  displayMinDb: number;
  displayMaxDb: number;
  /** The saved Freq Shift in Hz. */
  shiftHz: number;
}

/** The Receiver's scan defaults (state.ts). */
const DEFAULTS = { startMHz: 100, endMHz: 1000, fftSize: 8192 as SweepFftSize, lnaDb: 40, vgaDb: 20, amp: false, displayMinDb: -60, displayMaxDb: 0 } as const;
const LNA_STEPS = [0, 8, 16, 24, 32, 40];
const MIN_MHZ = SWEEP_LIMITS.minHz / 1e6;
const MAX_MHZ = SWEEP_LIMITS.maxHz / 1e6;

type StorageLike = Pick<Storage, 'getItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function finiteIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function readEntry(storage: StorageLike | null): Record<string, unknown> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(RECEIVER_SWEEP_SETTINGS_KEY);
    if (typeof raw !== 'string' || !raw || raw.length > RECEIVER_SWEEP_SETTINGS_MAX_CHARS) return {};
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The saved scan settings with the Receiver's rules for each field (overlay settings.ts restoreSweepSettings). */
export function savedReceiverSweep(storage: StorageLike | null = defaultStorage()): SavedReceiverSweep {
  const entry = readEntry(storage);
  const rangeOk = finiteIn(entry.startMHz, MIN_MHZ, MAX_MHZ) && finiteIn(entry.endMHz, MIN_MHZ, MAX_MHZ) && entry.endMHz > entry.startMHz;
  const startMHz = rangeOk ? entry.startMHz as number : DEFAULTS.startMHz;
  const endMHz = rangeOk ? entry.endMHz as number : DEFAULTS.endMHz;
  const fftSize = isSweepFftSize(entry.fftSize) ? entry.fftSize : DEFAULTS.fftSize;
  const graphOk = finiteIn(entry.displayMinDb, DISPLAY_DB_LIMITS.minDb, DISPLAY_DB_LIMITS.maxDb)
    && finiteIn(entry.displayMaxDb, DISPLAY_DB_LIMITS.minDb, DISPLAY_DB_LIMITS.maxDb)
    && entry.displayMaxDb - entry.displayMinDb >= DISPLAY_DB_LIMITS.minGapDb;
  const shiftHz = savedFrequencyShiftHz(storage);
  return {
    startHz: Math.round(startMHz * 1e6) + shiftHz,
    stopHz: Math.round(endMHz * 1e6) + shiftHz,
    fftSize,
    resolutionHz: SWEEP_SPAN_LIMITS.sampleRateHz / fftSize,
    lnaDb: typeof entry.lnaGain === 'number' && LNA_STEPS.includes(entry.lnaGain) ? entry.lnaGain : DEFAULTS.lnaDb,
    vgaDb: finiteIn(entry.vgaGain, 0, 62) && entry.vgaGain % 2 === 0 ? entry.vgaGain : DEFAULTS.vgaDb,
    amp: typeof entry.ampEnabled === 'boolean' ? entry.ampEnabled : DEFAULTS.amp,
    displayMinDb: graphOk ? entry.displayMinDb as number : DEFAULTS.displayMinDb,
    displayMaxDb: graphOk ? entry.displayMaxDb as number : DEFAULTS.displayMaxDb,
    shiftHz,
  };
}
