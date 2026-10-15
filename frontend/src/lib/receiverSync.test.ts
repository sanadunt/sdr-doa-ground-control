import { describe, expect, it } from 'vitest';
import { displayedTuning, settleLocalTune, watchReceiverTuning } from './receiverSync';
import type { LocalTune, TuningSource } from './receiverSync';
import type { BridgeState, TuneView } from './receiverBridge';
import type { ListenMode, ReceiverStatus } from './receiverBridgeProtocol';

function receiverStatus(mode: ListenMode | null): ReceiverStatus {
  return {
    seq: 1, tMs: 0, webusb: true, mockAvailable: false, pairedCount: 1, connected: true, mock: false, deviceName: null,
    running: true, busy: 'none', workspace: 'listener', centerHz: 100_000_000, sampleRateHz: 20_000_000, frequencyShiftHz: 0,
    gains: { lnaDb: null, vgaDb: null, amp: false },
    vfo: { index: 0, enabled: false, mode, frequencyHz: 100_000_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: null, volume: 50 },
    squelchOpen: false, audio: 'none', recording: false, error: null, notice: null, tune: null, display: null,
  };
}

function tuneView(rev: number, by: 'console' | 'receiver', receiverRev: number): TuneView {
  return { rev, by, commandId: by === 'console' ? `c${rev}-a` : null, receiverRev, centerHz: 100_000_000 + rev, vfoHz: 100_000_000 + rev };
}

/** A bridge state source driven by hand, with a send spy that must never be called. */
function fakeBridge() {
  let state: BridgeState = { phase: 'idle', build: 'built', hello: null, status: null, tune: null, lastResult: null };
  const listeners = new Set<() => void>();
  const sent: unknown[] = [];
  const source: TuningSource & { send(command: unknown): void } = {
    getState: () => state,
    onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    send: (command) => { sent.push(command); },
  };
  const update = (patch: Partial<BridgeState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  return { source, update, sent, listeners };
}

describe('watchReceiverTuning', () => {
  it('reports a Receiver-page retune after the baseline, never a console one', () => {
    const bridge = fakeBridge();
    let retunes = 0;
    const stop = watchReceiverTuning(bridge.source, { onReceiverTune: () => { retunes += 1; } });
    bridge.update({ phase: 'connecting' });
    // The first stamp after attach is the baseline, even when the Receiver set it.
    bridge.update({ phase: 'ready', status: receiverStatus('nfm'), tune: tuneView(3, 'receiver', 3) });
    expect(retunes).toBe(0);
    bridge.update({ tune: tuneView(4, 'console', 3) });
    bridge.update({ tune: tuneView(5, 'console', 3) });
    expect(retunes).toBe(0);
    bridge.update({ tune: tuneView(6, 'receiver', 6) });
    expect(retunes).toBe(1);
    bridge.update({ tune: tuneView(6, 'receiver', 6) });
    expect(retunes).toBe(1);
    // A Receiver edit coalesced with a later console tune still counts: receiverRev rose.
    bridge.update({ tune: tuneView(8, 'console', 7) });
    expect(retunes).toBe(2);
    stop();
    bridge.update({ tune: tuneView(9, 'receiver', 9) });
    expect(retunes).toBe(2);
    expect(bridge.listeners.size).toBe(0);
    expect(bridge.sent).toEqual([]);
  });

  it('takes a new baseline after the frame goes away or reloads', () => {
    const bridge = fakeBridge();
    let retunes = 0;
    watchReceiverTuning(bridge.source, { onReceiverTune: () => { retunes += 1; } });
    bridge.update({ phase: 'ready', status: receiverStatus('nfm'), tune: tuneView(5, 'receiver', 5) });
    bridge.update({ phase: 'connecting', status: null, tune: null });
    // The reloaded Receiver counts from 0 again; its first stamp is not a retune.
    bridge.update({ phase: 'ready', status: receiverStatus('nfm'), tune: tuneView(0, 'receiver', 0) });
    expect(retunes).toBe(0);
    bridge.update({ tune: tuneView(1, 'receiver', 1) });
    expect(retunes).toBe(1);
    // A frame that sends no stamp cannot be attributed.
    bridge.update({ tune: null });
    bridge.update({ tune: tuneView(2, 'receiver', 2) });
    expect(retunes).toBe(1);
  });

  it('reports the mode the Receiver uses, then every change of it', () => {
    const bridge = fakeBridge();
    const modes: ListenMode[] = [];
    watchReceiverTuning(bridge.source, { onReceiverTune: () => undefined, onReceiverMode: (mode) => modes.push(mode) });
    bridge.update({ phase: 'ready', status: receiverStatus('am') });
    bridge.update({ status: receiverStatus('am') });
    bridge.update({ status: receiverStatus(null) });
    bridge.update({ status: receiverStatus('wfm') });
    expect(modes).toEqual(['am', 'wfm']);
    bridge.update({ phase: 'idle', status: null });
    bridge.update({ phase: 'ready', status: receiverStatus('wfm') });
    expect(modes).toEqual(['am', 'wfm', 'wfm']);
    expect(bridge.sent).toEqual([]);
  });
});

describe('displayedTuning', () => {
  const local = (overrides: Partial<LocalTune> = {}): LocalTune => ({ token: 1, centerHz: 145_500_000, vfoHz: 145_510_000, awaitRev: null, ...overrides });
  const frame = (rev: number, centerHz = 100_000_000): Pick<TuneView, 'rev' | 'centerHz' | 'vfoHz'> => ({ rev, centerHz, vfoHz: centerHz });

  it('shows the dock tune until the frame reports its rev', () => {
    expect(displayedTuning(local(), frame(3))).toEqual({ centerHz: 145_500_000, vfoHz: 145_510_000 });
    expect(displayedTuning(local(), null)).toEqual({ centerHz: 145_500_000, vfoHz: 145_510_000 });
    expect(displayedTuning(local({ awaitRev: 4 }), frame(3))).toEqual({ centerHz: 145_500_000, vfoHz: 145_510_000 });
    expect(displayedTuning(local({ awaitRev: 4 }), frame(4, 145_500_000))).toEqual({ centerHz: 145_500_000, vfoHz: 145_500_000 });
    // A later Receiver change wins over the settled dock tune.
    expect(displayedTuning(local({ awaitRev: 4 }), frame(5, 150_000_000))).toEqual({ centerHz: 150_000_000, vfoHz: 150_000_000 });
  });

  it('shows the frame without a dock tune, and nothing once a settled tune has no frame', () => {
    expect(displayedTuning(null, frame(2))).toEqual({ centerHz: 100_000_000, vfoHz: 100_000_000 });
    expect(displayedTuning(null, null)).toBeNull();
    expect(displayedTuning(local({ awaitRev: 4 }), null)).toBeNull();
  });
});

describe('settleLocalTune', () => {
  const local = (overrides: Partial<LocalTune> = {}): LocalTune => ({ token: 2, centerHz: 145_500_000, vfoHz: 145_500_000, awaitRev: null, ...overrides });

  it('drops a refused tune and one the TuneView already shows', () => {
    expect(settleLocalTune(local(), 2, { ok: false, tune: { rev: 4 } }, { rev: 4 })).toBeNull();
    expect(settleLocalTune(local(), 2, { ok: true }, { rev: 4 })).toBeNull();
    // The bridge merges the result's tuning before the command settles, so this is the usual case.
    expect(settleLocalTune(local(), 2, { ok: true, tune: { rev: 5 } }, { rev: 5 })).toBeNull();
    expect(settleLocalTune(local(), 2, { ok: true, tune: { rev: 5 } }, null)).toBeNull();
  });

  it('waits for the rev only while the TuneView is behind, and ignores an older command', () => {
    expect(settleLocalTune(local(), 2, { ok: true, tune: { rev: 5 } }, { rev: 4 })).toEqual(local({ awaitRev: 5 }));
    const newer = local({ token: 3 });
    expect(settleLocalTune(newer, 2, { ok: false }, { rev: 4 })).toBe(newer);
    expect(settleLocalTune(null, 2, { ok: true, tune: { rev: 5 } }, { rev: 5 })).toBeNull();
  });

  it('never shows a settled tune again once a reloaded Receiver counts from 0', () => {
    // A kept tune with awaitRev 12 would hide every rev of the new frame below 12.
    const settled = settleLocalTune(local(), 2, { ok: true, tune: { rev: 12 } }, { rev: 12 });
    expect(displayedTuning(settled, { rev: 1, centerHz: 150_000_000, vfoHz: 150_000_000 })).toEqual({ centerHz: 150_000_000, vfoHz: 150_000_000 });
  });
});
