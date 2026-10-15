/**
 * Frequency sync between the Receiver page and the Overview spectrum dock.
 * The hidden Receiver frame owns the centre and the VFO; the console only
 * mirrors them through the bridge state (TuneView) and never writes them back
 * on its own.
 *
 * watchReceiverTuning() runs once in App for the life of the console page, so
 * it also sees changes made while the dock is not mounted. It only reports;
 * the caller writes preferences and sends nothing, so no echo loop can form.
 */
import type { BridgeState, TuneView } from './receiverBridge';
import type { ListenMode } from './receiverBridgeProtocol';

export interface ReceiverTuningHandlers {
  /** The centre or the active VFO was changed on the Receiver page (any change not made by a console command). */
  onReceiverTune(): void;
  /** The Receiver reports a demodulation mode other than the one it reported before. */
  onReceiverMode?(mode: ListenMode): void;
}

export interface TuningSource {
  getState(): BridgeState;
  onState(listener: () => void): () => void;
}

/**
 * Calls onReceiverTune when the frame's receiverRev increases. The first stamp
 * after a frame attaches is the baseline and never fires, and a console
 * command never raises receiverRev. Also reports the Receiver's mode: the
 * first one a frame reports and every later change. Returns the unsubscribe
 * function.
 */
export function watchReceiverTuning(source: TuningSource, handlers: ReceiverTuningHandlers): () => void {
  let baseline: number | null = null;
  let lastMode: ListenMode | null = null;
  const check = (): void => {
    const state = source.getState();
    const tune = state.phase === 'ready' ? state.tune : null;
    if (!tune) {
      baseline = null;
    } else if (baseline === null) {
      baseline = tune.receiverRev;
    } else if (tune.receiverRev > baseline) {
      baseline = tune.receiverRev;
      handlers.onReceiverTune();
    }
    const status = state.phase === 'ready' ? state.status : null;
    if (!status) {
      lastMode = null;
      return;
    }
    const mode = status.vfo?.mode ?? null;
    if (mode !== null && mode !== lastMode) {
      lastMode = mode;
      handlers.onReceiverMode?.(mode);
    }
  };
  check();
  return source.onState(check);
}

/** A tuning the dock asked for and shows before the frame confirms it. */
export interface LocalTune {
  /** Increases with every dock tune; a result for an older token is ignored. */
  token: number;
  centerHz: number;
  vfoHz: number;
  /** The tune rev the frame answered with; null while the command is on its way. */
  awaitRev: number | null;
}

export interface DisplayedTuning {
  centerHz: number | null;
  vfoHz: number | null;
}

/**
 * What the dock shows: its own pending tune until the frame reports that rev
 * (or a later one), then the frame's tuning. Without a frame a settled local
 * tune shows nothing.
 */
export function displayedTuning(local: LocalTune | null, tune: Pick<TuneView, 'rev' | 'centerHz' | 'vfoHz'> | null): DisplayedTuning | null {
  if (local && local.awaitRev === null) return { centerHz: local.centerHz, vfoHz: local.vfoHz };
  if (local && tune && tune.rev < (local.awaitRev ?? 0)) return { centerHz: local.centerHz, vfoHz: local.vfoHz };
  return tune ? { centerHz: tune.centerHz, vfoHz: tune.vfoHz } : null;
}

/**
 * The dock's local tune once the command with `token` settled. A refused tune
 * is dropped (the dock snaps back to the frame), and so is one the frame's
 * TuneView already covers, so a settled local tune never waits for a rev a
 * reloaded Receiver, counting from 0 again, would only reach much later.
 * A result for an older token leaves `current` as it is.
 */
export function settleLocalTune(
  current: LocalTune | null,
  token: number,
  result: { ok: boolean; tune?: { rev: number } },
  view: Pick<TuneView, 'rev'> | null,
): LocalTune | null {
  if (!current || current.token !== token) return current;
  if (!result.ok || !result.tune || !view || view.rev >= result.tune.rev) return null;
  return { ...current, awaitRev: result.tune.rev };
}
