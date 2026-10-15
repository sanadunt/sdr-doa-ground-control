/**
 * The Spektrum dock's RX radio settings: sample rate, LNA, VGA and the RF amp
 * (+14 dB). They belong to the Receiver's Listener (saved in its SDRSetting);
 * the dock shows what the frame reports and changes them through
 * console:radio and console:gains. A value the operator picks is held until
 * the Receiver reports on it, as the demodulation mode is.
 */
import type { ReceiverStatus } from './receiverBridgeProtocol';
import { SAMPLE_RATES_HZ } from './receiverBridgeProtocol';

/** A value picked in the dock, shown until a receiver status newer than its result arrives. */
export interface HeldPick<T> {
  value: T;
  /** Increases with every pick; the result of an older one leaves a newer pick alone. */
  token: number;
  /** The status current when the frame accepted the pick; undefined while the command is on its way. */
  settledOn?: ReceiverStatus | null;
}

/** The held value, or null once the frame has reported after accepting it (the status then shows it). */
export function heldValue<T>(pick: HeldPick<T> | null, status: ReceiverStatus | null): T | null {
  return pick && (pick.settledOn === undefined || pick.settledOn === status) ? pick.value : null;
}

/** The pick after the command with `token` answered: kept until the next status when accepted, dropped when refused. */
export function settlePick<T>(current: HeldPick<T> | null, token: number, ok: boolean, status: ReceiverStatus | null): HeldPick<T> | null {
  if (!current || current.token !== token || current.settledOn !== undefined) return current;
  return ok ? { ...current, settledOn: status } : null;
}

/**
 * Sample rates the select offers: the connected device's that a console:radio
 * may set, or the RadioSpectrum list before one connects, plus the current
 * rate when it is neither, so the select still shows it.
 */
export function sampleRateOptions(deviceRates: readonly number[] | null | undefined, current: number | null): number[] {
  const allowed = SAMPLE_RATES_HZ as readonly number[];
  const fromDevice = (deviceRates ?? []).filter((rate) => allowed.includes(rate));
  const options = fromDevice.length ? [...fromDevice] : [...allowed];
  if (current !== null && Number.isFinite(current) && current > 0 && !options.includes(current)) options.push(current);
  return options.sort((left, right) => left - right);
}

/** The RX radio settings as the dock shows them (the Receiver's, with a pick held until it reports it). */
export interface RadioRows {
  /** The Receiver frame answers; otherwise every radio control is disabled and shows '—'. */
  ready: boolean;
  sampleRateHz: number | null;
  sampleRates: readonly number[];
  /** No frame, a scan or a start: the rate select is disabled. */
  rateDisabled: boolean;
  /**
   * A sample rate change is on its way (RX restarts). The select takes no new pick but stays
   * focusable (aria-disabled), so a keyboard pick does not lose focus to the page.
   */
  ratePending: boolean;
  lnaDb: number | null;
  vgaDb: number | null;
  amp: boolean | null;
  gainsDisabled: boolean;
}

export interface RadioRowsInput {
  /** The Receiver's status while its frame answers, otherwise null. */
  live: ReceiverStatus | null;
  /** The values shown: a held pick, else the status value. */
  shown: { sampleRateHz: number | null; lnaDb: number | null; vgaDb: number | null; amp: boolean | null };
  ratePending: boolean;
  /** A Mulai/Dengar start is on its way. */
  starting: boolean;
}

/**
 * Atur's radio rows. They need the frame, which Atur never mounts (mounting
 * claims the radio). Any scan owns the radio, so the rate waits; one rate
 * change restarts RX at a time. Gains follow the SWEEP_BUSY rule: a wide scan
 * keeps them for the next RX start, a scan listen or a scan start that still
 * has RX running refuses them.
 */
export function radioRows({ live, shown, ratePending, starting }: RadioRowsInput): RadioRows {
  const ready = live !== null;
  const busy = live?.busy ?? 'none';
  return {
    ready,
    sampleRateHz: shown.sampleRateHz,
    sampleRates: sampleRateOptions(live?.sampleRatesHz, shown.sampleRateHz),
    rateDisabled: !ready || busy !== 'none' || starting,
    ratePending,
    lnaDb: shown.lnaDb,
    vgaDb: shown.vgaDb,
    amp: shown.amp,
    gainsDisabled: !ready || busy === 'scan-listen' || (busy === 'sweep' && live?.running === true),
  };
}

/** A sample rate in MSPS without trailing zeros: 20, 2.4. */
export function formatMsps(hz: number | null | undefined): string {
  if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0) return '—';
  return String(Number((hz / 1e6).toFixed(3)));
}
