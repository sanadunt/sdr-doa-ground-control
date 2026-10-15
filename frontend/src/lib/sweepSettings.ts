/**
 * The Spektrum dock's scan rows in the "Atur" column: the Receiver's wide
 * scan range, resolution and gains. They belong to the Receiver (saved in its
 * ReceiverSweepSettings); the dock shows what the frame reports, holds a pick
 * until it does, and changes them with console:sweep-config. Like the
 * Receiver page, the dock offers them only while no scan runs.
 */
import { SWEEP_LIMITS, inSweepRange, sweepMaxSpanHz } from './receiverBridgeProtocol';
import type { ReceiverStatus, SweepFftSize } from './receiverBridgeProtocol';
import type { SavedReceiverSweep } from './receiverSavedSweep';
import { snapHz } from './spectrumView';

export interface SweepRange {
  startHz: number;
  stopHz: number;
}

/** The scan settings as the dock shows them. */
export interface SweepRows {
  /** The Receiver frame answers; before that the rows show its saved settings, disabled. */
  ready: boolean;
  /** A scan starts, runs or stops, or a scan listen holds the radio: the settings are read-only. */
  scanning: boolean;
  /** No frame, a scan, or a dock start on its way. */
  disabled: boolean;
  startHz: number | null;
  stopHz: number | null;
  fftSize: SweepFftSize | null;
  lnaDb: number | null;
  vgaDb: number | null;
  amp: boolean | null;
  /** The Receiver's Freq Shift: the range is in displayed Hz, the limits are the device's plus this. */
  shiftHz: number;
}

export interface SweepRowsInput {
  /** The Receiver's status while its frame answers, otherwise null. */
  live: ReceiverStatus | null;
  /** The values shown: a held pick, else the status value, else the saved one. */
  shown: { range: SweepRange | null; fftSize: SweepFftSize | null; lnaDb: number | null; vgaDb: number | null; amp: boolean | null };
  /** The saved settings, used before the frame is mounted. */
  saved: SavedReceiverSweep | null;
  /** A Mulai/Dengar start is on its way. */
  starting: boolean;
}

export function sweepRows({ live, shown, saved, starting }: SweepRowsInput): SweepRows {
  const ready = live !== null;
  const scanning = (live?.busy ?? 'none') !== 'none';
  return {
    ready,
    scanning,
    disabled: !ready || scanning || starting,
    startHz: shown.range?.startHz ?? null,
    stopHz: shown.range?.stopHz ?? null,
    fftSize: shown.fftSize,
    lnaDb: shown.lnaDb,
    vgaDb: shown.vgaDb,
    amp: shown.amp,
    shiftHz: live ? live.frequencyShiftHz : saved?.shiftHz ?? 0,
  };
}

/** The displayed limits of a scan range: the device range moved by the shift, and the widest span at this FFT size. */
export function sweepRangeLimits(shiftHz: number, fftSize: SweepFftSize): { minHz: number; maxHz: number; maxSpanHz: number } {
  return { minHz: SWEEP_LIMITS.minHz + shiftHz, maxHz: SWEEP_LIMITS.maxHz + shiftHz, maxSpanHz: sweepMaxSpanHz(fftSize) };
}

/**
 * "Pusatkan ke RX": the same span centred on the RX centre, moved back inside
 * the device range when it would leave it, on the 1 kHz grid. null when no
 * such range is valid.
 */
export function recentredRange(range: SweepRange, centerHz: number, shiftHz: number, fftSize: SweepFftSize): SweepRange | null {
  const span = range.stopHz - range.startHz;
  if (!Number.isFinite(centerHz) || !Number.isFinite(span) || span <= 0) return null;
  const { minHz, maxHz } = sweepRangeLimits(shiftHz, fftSize);
  const startHz = Math.min(maxHz - span, Math.max(minHz, snapHz(centerHz - span / 2)));
  const next = { startHz, stopHz: startHz + span };
  return inSweepRange(next.startHz, next.stopHz, fftSize, shiftHz) ? next : null;
}
