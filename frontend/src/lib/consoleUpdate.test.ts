import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleUpdateError, HELPER_TAKE_MS, UPDATE_CLOSED, canSendUpdate, normalizeConsoleUpdate, readConsoleUpdate, requestConsoleUpdate,
  updateChip, updateProgress, updateRunning, updateStep,
} from './consoleUpdate';
import type { ConsoleUpdateView, UpdateEvent, UpdateStatus, UpdateStep } from './consoleUpdate';

const NOW = 1_800_000_000_000;

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    installed: '3.22.0',
    latest: { state: 'ok', version: '3.23.0', url: 'https://github.com/sanadunt/sdr-doa-ground-control/releases/tag/v3.23.0', published_at: null, code: null, error: null, checked_at_ms: NOW, major: 3 },
    update_available: true,
    helper: { available: true, reason: null },
    status: null,
    now_ms: NOW,
    ...overrides,
  };
}

function status(overrides: Partial<UpdateStatus>): UpdateStatus {
  return { state: 'running', phase: 'pulling', queuedAtMs: NOW, startedAtMs: NOW + 1000, finishedAtMs: null, to: null, message: null, stale: false, ...overrides };
}

function view(overrides: Partial<ConsoleUpdateView> = {}): ConsoleUpdateView {
  const base = normalizeConsoleUpdate(answer());
  if (!base) throw new Error('fixture');
  return { ...base, ...overrides };
}

const WAITING: UpdateStep = { stage: 'waiting', requestedAtMs: NOW, fromVersion: '3.22.0' };

describe('normalizeConsoleUpdate', () => {
  it('reads the answer of GET /api/host/update', () => {
    const value = normalizeConsoleUpdate(answer({
      status: { state: 'rolled_back', phase: null, queued_at_ms: NOW, started_at_ms: NOW, finished_at_ms: NOW + 5000, to: '3.23.0', message: 'FAILED: x', stale: false },
    }));
    expect(value).toEqual({
      installed: '3.22.0',
      latest: { state: 'ok', version: '3.23.0', url: 'https://github.com/sanadunt/sdr-doa-ground-control/releases/tag/v3.23.0', code: null, major: 3 },
      updateAvailable: true,
      helper: { available: true, reason: null },
      status: { state: 'rolled_back', phase: null, queuedAtMs: NOW, startedAtMs: NOW, finishedAtMs: NOW + 5000, to: '3.23.0', message: 'FAILED: x', stale: false },
    });
  });

  it('keeps unknown values out and refuses another shape', () => {
    expect(normalizeConsoleUpdate(null)).toBeNull();
    expect(normalizeConsoleUpdate({ ...answer(), ok: false })).toBeNull();
    expect(normalizeConsoleUpdate({ ...answer(), helper: {} })).toBeNull();
    const odd = normalizeConsoleUpdate(answer({
      latest: { state: 'ok', version: 'latest', url: 'http://evil.example', code: 'NOPE', major: '3' },
      helper: { available: false, reason: 'SOMETHING_NEW' },
      status: { state: 'exploded' },
    }));
    expect(odd?.latest).toEqual({ state: 'error', version: null, url: null, code: null, major: null });
    expect(odd?.updateAvailable).toBe(false);
    expect(odd?.helper).toEqual({ available: false, reason: null });
    expect(odd?.status).toBeNull();
    expect(normalizeConsoleUpdate(answer({ latest: { state: 'error', code: 'OFFLINE', major: 3 }, update_available: true }))?.latest)
      .toEqual({ state: 'error', version: null, url: null, code: 'OFFLINE', major: 3 });
  });
});

describe('the confirm step', () => {
  it('opens, waits for the Receiver, sends and follows the request', () => {
    let step = UPDATE_CLOSED;
    const go = (event: UpdateEvent) => { step = updateStep(step, event); return step; };
    expect(go({ type: 'open' })).toEqual({ stage: 'confirm', busy: 'checking' });
    expect(canSendUpdate(step)).toBe(false);
    expect(go({ type: 'send' }).stage).toBe('confirm');
    go({ type: 'health', busy: 'busy' });
    expect(canSendUpdate(step)).toBe(true);
    expect(go({ type: 'send' })).toEqual({ stage: 'sending', busy: 'busy' });
    expect(go({ type: 'cancel' }).stage).toBe('sending');
    expect(go({ type: 'sent', requestedAtMs: NOW, fromVersion: '3.22.0' })).toEqual(WAITING);
    expect(go({ type: 'cancel' })).toEqual(WAITING);
    // Once this page's update ended, Update may be asked again.
    expect(go({ type: 'open' }).stage).toBe('confirm');
    expect(go({ type: 'cancel' })).toEqual(UPDATE_CLOSED);
  });

  it('keeps a refusal with its known code and reason', () => {
    const sending: UpdateStep = { stage: 'sending', busy: 'idle' };
    expect(updateStep(sending, { type: 'refused', code: 'HOST_UPDATE_RUNNING', message: 'x' }))
      .toEqual({ stage: 'refused', code: 'HOST_UPDATE_RUNNING', reason: null, message: 'x' });
    expect(updateStep(sending, { type: 'refused', code: 'HOST_UPDATE_UNAVAILABLE', reason: 'UPDATE_HELPER_MISSING', message: 'x' }))
      .toMatchObject({ reason: 'UPDATE_HELPER_MISSING' });
    expect(updateStep(sending, { type: 'refused', code: 'WHAT', reason: 'EVER', message: 'x' })).toMatchObject({ code: null, reason: null });
    expect(updateStep(UPDATE_CLOSED, { type: 'refused', code: null, message: 'x' })).toEqual(UPDATE_CLOSED);
  });
});

describe('updateProgress', () => {
  it('waits for the helper, names it when it does not come, then follows each phase', () => {
    expect(updateProgress(view(), WAITING, true, NOW + 1000)).toEqual({ kind: 'waitingHelper', slow: false });
    expect(updateProgress(view(), WAITING, true, NOW + HELPER_TAKE_MS + 1)).toEqual({ kind: 'waitingHelper', slow: true });
    // An older update's state is not this page's.
    expect(updateProgress(view({ status: status({ state: 'failed', queuedAtMs: NOW - 60_000, startedAtMs: NOW - 59_000 }) }), WAITING, true, NOW).kind).toBe('waitingHelper');
    expect(updateProgress(view({ status: status({ state: 'queued', phase: null, startedAtMs: null }) }), WAITING, true, NOW))
      .toEqual({ kind: 'running', label: 'update.state.queued' });
    for (const phase of ['preparing', 'pulling', 'starting', 'rolling_back'] as const) {
      expect(updateProgress(view({ status: status({ phase }) }), WAITING, true, NOW)).toEqual({ kind: 'running', label: `update.phase.${phase}` });
    }
  });

  it('rides out the restart and reloads once the new version answers', () => {
    expect(updateProgress(view(), WAITING, false, NOW)).toEqual({ kind: 'running', label: 'update.progress.restarting' });
    const ok = status({ state: 'ok', phase: null, finishedAtMs: NOW + 9000, to: '3.23.0' });
    expect(updateProgress(view({ status: ok }), WAITING, true, NOW + 10_000).kind).toBe('running');
    expect(updateProgress(view({ installed: '3.23.0', status: ok }), WAITING, true, NOW + 10_000))
      .toEqual({ kind: 'done', state: 'ok', to: '3.23.0', message: null, reload: true });
    // Even when the helper's state cannot be read.
    expect(updateProgress(view({ installed: '3.23.0' }), WAITING, true, NOW).kind).toBe('done');
    // An ok that kept the version (the same image restarted) ends the wait after 30 s.
    expect(updateProgress(view({ status: ok }), WAITING, true, NOW + 40_000)).toEqual({ kind: 'done', state: 'ok', to: '3.23.0', message: null, reload: false });
  });

  it('ends with the helper\'s result', () => {
    for (const state of ['up_to_date', 'not_updated', 'rolled_back', 'failed', 'dry_run'] as const) {
      const value = updateProgress(view({ status: status({ state, phase: null, message: 'why', to: '3.23.0' }) }), WAITING, true, NOW);
      expect(value).toEqual({ kind: 'done', state, to: '3.23.0', message: 'why', reload: false });
    }
    expect(updateProgress(view({ status: status({ stale: true }) }), WAITING, true, NOW)).toMatchObject({ kind: 'done', state: 'failed' });
  });

  it('shows an update the page found on its way, and nothing otherwise', () => {
    expect(updateProgress(view({ status: status({ phase: 'starting' }) }), UPDATE_CLOSED, true, NOW))
      .toEqual({ kind: 'running', label: 'update.phase.starting' });
    expect(updateProgress(view({ status: status({ stale: true }) }), UPDATE_CLOSED, true, NOW)).toEqual({ kind: 'none' });
    expect(updateProgress(view({ status: status({ state: 'ok' }) }), UPDATE_CLOSED, true, NOW)).toEqual({ kind: 'none' });
    expect(updateRunning(null)).toBe(false);
  });
});

describe('updateChip', () => {
  it('names the state in a code', () => {
    expect(updateChip(null, { kind: 'none' })).toEqual({ code: 'CHECKING', tone: 'neutral' });
    expect(updateChip(view(), { kind: 'none' })).toEqual({ code: 'UPDATE AVAILABLE', tone: 'signal' });
    expect(updateChip(view({ updateAvailable: false }), { kind: 'none' })).toEqual({ code: 'UP TO DATE', tone: 'good' });
    expect(updateChip(view({ updateAvailable: false, latest: { state: 'error', version: null, url: null, code: 'OFFLINE', major: 3 } }), { kind: 'none' }).code).toBe('OFFLINE');
    expect(updateChip(view(), { kind: 'waitingHelper', slow: false }).code).toBe('UPDATING');
  });
});

describe('the requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the view, with refresh only when asked', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await readConsoleUpdate(false)).latest.version).toBe('3.23.0');
    await readConsoleUpdate(true);
    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['/api/host/update', '/api/host/update?refresh=1']);
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 403 }));
    await expect(readConsoleUpdate(false)).rejects.toThrow('HTTP 403');
  });

  it('posts confirm: true and keeps the server\'s code', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, requested_at_ms: NOW }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestConsoleUpdate()).toBe(NOW);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"confirm":true}');
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, code: 'HOST_UPDATE_UNAVAILABLE', reason: 'NOT_DOCKER', error: 'native' }), { status: 503 }));
    const error = await requestConsoleUpdate().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConsoleUpdateError);
    expect(error).toMatchObject({ code: 'HOST_UPDATE_UNAVAILABLE', reason: 'NOT_DOCKER', message: 'native' });
  });
});
