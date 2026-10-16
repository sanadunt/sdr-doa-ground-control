/**
 * The Spektrum dock's own settings, kept on the console like the other
 * preferences (key sdr-console-spectrum-dock-v1): the RX dB scale as last
 * known, the mode Mulai starts (RX or the wide scan, Spektrum) and whether the
 * scan's dB scale is Auto.
 *
 * The RX dB scale belongs to the Receiver (its Dengar tab, saved in
 * SDRSetting). The dock mirrors it through the bridge and keeps the last value
 * here, so it draws with it before the frame is mounted. A change made in the
 * dock is marked pending until the Receiver has taken it; one made while no
 * frame answers is sent when the frame says hello (watchReceiverDisplay in
 * lib/receiverSync.ts).
 *
 * The scan's manual range is the Receiver's own Graph min./max. (saved with
 * its scan settings), so only the Auto choice is kept here; Auto draws the
 * scan with the dock's own automatic range and changes nothing on the Receiver.
 *
 * spectrumDockStore holds the value for the whole console page, so App can
 * mirror the Receiver while the dock is not mounted. Every field is validated
 * on restore and falls back to its default on its own.
 */
import { preferenceStorage } from './preferenceStore';
import { DISPLAY_DB_LIMITS, clampDisplayRange } from './receiverBridgeProtocol';
import type { StatusDisplay } from './receiverBridgeProtocol';
import type { PreferenceValueStore } from './listenPrefs';

export const SPECTRUM_DOCK_STORAGE_KEY = 'sdr-console-spectrum-dock-v1';
/** Larger stored values are ignored. */
export const SPECTRUM_DOCK_MAX_CHARS = 1024;

/** The RX dB scale: Auto, or minDb to maxDb (kept while Auto is on). */
export type DbScale = StatusDisplay;

/** RX: the 2 MHz around the RX centre. sweep: the Receiver's wide scan (Spektrum). */
export const DOCK_MODES = ['rx', 'sweep'] as const;
export type DockMode = typeof DOCK_MODES[number];

export interface SpectrumDockSettings {
  rxDb: DbScale;
  /** A dock change of rxDb the Receiver has not taken yet. */
  rxDbPending: boolean;
  /** What Mulai starts while nothing runs; the dock shows the mode that runs. */
  mode: DockMode;
  /** The scan's dB scale is the dock's automatic one; otherwise the Receiver's Graph min./max. */
  sweepAuto: boolean;
}

/** The Receiver's own default: Auto, with the upstream −70 to 0 dB manual range. */
export const DEFAULT_RX_DB: Readonly<DbScale> = Object.freeze({ auto: true, minDb: -70, maxDb: 0 });
export const DEFAULT_SPECTRUM_DOCK_SETTINGS: Readonly<SpectrumDockSettings> = Object.freeze({ rxDb: DEFAULT_RX_DB, rxDbPending: false, mode: 'rx', sweepAuto: true });

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

// localStorage, with writes copied to the console server (lib/preferenceStore.ts).
function defaultStorage(): StorageLike | null {
  return preferenceStorage();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A dB scale from an untrusted value; null when it is not one. */
export function validDbScale(value: unknown): DbScale | null {
  if (!isRecord(value) || typeof value.auto !== 'boolean') return null;
  const range = clampDisplayRange(value.minDb, value.maxDb);
  return range ? { auto: value.auto, ...range } : null;
}

export function sameDbScale(left: DbScale, right: DbScale): boolean {
  return left.auto === right.auto && left.minDb === right.minDb && left.maxDb === right.maxDb;
}

export function validateSpectrumDockSettings(value: unknown): SpectrumDockSettings {
  const input = isRecord(value) ? value : {};
  const rxDb = validDbScale(input.rxDb);
  return {
    rxDb: rxDb ?? { ...DEFAULT_RX_DB },
    // A pending flag without a usable scale has nothing to send.
    rxDbPending: rxDb !== null && input.rxDbPending === true,
    mode: input.mode === 'sweep' ? 'sweep' : 'rx',
    sweepAuto: input.sweepAuto !== false,
  };
}

export function loadSpectrumDockSettings(storage: StorageLike | null = defaultStorage()): SpectrumDockSettings {
  if (!storage) return validateSpectrumDockSettings(null);
  try {
    const raw = storage.getItem(SPECTRUM_DOCK_STORAGE_KEY);
    return validateSpectrumDockSettings(raw && raw.length <= SPECTRUM_DOCK_MAX_CHARS ? JSON.parse(raw) : null);
  } catch {
    return validateSpectrumDockSettings(null);
  }
}

export function saveSpectrumDockSettings(settings: SpectrumDockSettings, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SPECTRUM_DOCK_STORAGE_KEY, JSON.stringify(validateSpectrumDockSettings(settings)));
  } catch {
    // Local persistence is optional; the in-memory choice still applies.
  }
}

/**
 * A typed limit kept valid against the other one, as the Receiver keeps its
 * own (overlay keepListenerRange): the edited value gives way, the other stays
 * where it can, inside DISPLAY_DB_LIMITS and minGapDb apart, in 0.1 dB steps.
 */
export function keepDbRange(minDb: number, maxDb: number, changed: 'min' | 'max'): { minDb: number; maxDb: number } {
  const { minDb: floor, maxDb: ceiling, minGapDb: gap } = DISPLAY_DB_LIMITS;
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const round = (value: number) => Math.round(value * 10) / 10;
  const min = Number.isFinite(minDb) ? round(minDb) : DEFAULT_RX_DB.minDb;
  const max = Number.isFinite(maxDb) ? round(maxDb) : DEFAULT_RX_DB.maxDb;
  if (changed === 'min') {
    const keptMax = clamp(max, floor + gap, ceiling);
    return { minDb: round(clamp(min, floor, keptMax - gap)), maxDb: keptMax };
  }
  const keptMin = clamp(min, floor, ceiling - gap);
  return { minDb: keptMin, maxDb: round(clamp(max, keptMin + gap, ceiling)) };
}

/** Manual starts from the range drawn now, in whole dB; without one it keeps the stored manual range. */
export function manualFromDrawn(drawn: { min: number; max: number } | null, current: DbScale): DbScale {
  const range = drawn ? clampDisplayRange(Math.round(drawn.min), Math.round(drawn.max)) : null;
  return { auto: false, ...(range ?? { minDb: current.minDb, maxDb: current.maxDb }) };
}

export function sameSpectrumDockSettings(left: SpectrumDockSettings, right: SpectrumDockSettings): boolean {
  return left.rxDbPending === right.rxDbPending && sameDbScale(left.rxDb, right.rxDb) && left.mode === right.mode && left.sweepAuto === right.sweepAuto;
}

/** A page-wide store of the dock settings; an equal value is neither saved nor announced. */
export function createSpectrumDockStore(
  load: () => SpectrumDockSettings = () => loadSpectrumDockSettings(),
  save: (settings: SpectrumDockSettings) => void = (settings) => saveSpectrumDockSettings(settings),
): PreferenceValueStore<SpectrumDockSettings> {
  let value: SpectrumDockSettings | null = null;
  const listeners = new Set<() => void>();
  const get = (): SpectrumDockSettings => {
    if (value === null) value = load();
    return value;
  };
  return {
    get,
    set(next) {
      const validated = validateSpectrumDockSettings(next);
      if (sameSpectrumDockSettings(get(), validated)) return;
      value = validated;
      save(validated);
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // One failing subscriber must not stop the others.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const spectrumDockStore: PreferenceValueStore<SpectrumDockSettings> = createSpectrumDockStore();
