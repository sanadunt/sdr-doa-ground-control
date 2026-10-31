import { describe, expect, it } from 'vitest';
import {
  MIRROR_MARK_POLL_MS,
  MIRROR_MARK_WAIT_MS,
  createMirrorMarkClient,
  createMirrorMarkController,
  markCommandId,
  mirrorMarkBlocked,
  mirrorMarkMessage,
} from './receiverMirrorMarks';
import type { MirrorMarkAnswer, MirrorMarkClient, MirrorMarkCode, MirrorMarkContext, MirrorMarkEnvironment, MirrorMarkOutcome } from './receiverMirrorMarks';
import { MARKER_COMMAND_ID_PATTERN, MIRROR_MARKERS_ROUTE, MIRROR_MARKER_ERROR_CODES, MIRROR_MARKER_RESULT_CODES } from './receiverMirror';
import type { MirrorPhase } from './receiverMirror';
import type { BridgeMarker } from './receiverBridgeProtocol';
import { translate } from './i18n';

type Request = { method: 'GET' | 'POST'; path: string; body: unknown; at: number };

/** A fake console on a fake clock: each request takes the next answer of its kind. */
function console_(answers: { post?: Array<MirrorMarkAnswer | Error>; get?: Array<MirrorMarkAnswer | Error> } = {}) {
  let now = 50_000;
  let nextHandle = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const requests: Request[] = [];
  const posts = [...(answers.post ?? [])];
  const gets = [...(answers.get ?? [])];
  const env: MirrorMarkEnvironment = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { due: now + ms, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
    request: (method, path, body) => {
      requests.push({ method, path, body: body === null ? null : JSON.parse(body), at: now });
      const answer = (method === 'POST' ? posts : gets).shift() ?? { status: 200, body: { status: 'sent' } };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    random: () => 0.25,
  };
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  /** Run timers up to `ms` from now. */
  const advance = async (ms: number) => {
    const end = now + ms;
    await settle();
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = Math.max(now, next[1].due);
      timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    now = end;
    await settle();
  };
  return { env, requests, advance, settle };
}

const accepted = (id = 'tab-9999999999999999'): MirrorMarkAnswer => ({ status: 202, body: { ok: true, id, status: 'queued' } });
const done = (code: string, markerId: string | null = null): MirrorMarkAnswer => ({ status: 200, body: { ok: true, status: 'done', code, marker_id: markerId } });

describe('marker client', () => {
  it('names each command with a random id the console takes', () => {
    expect(markCommandId(() => 0.25)).toBe('tab-9999999999999999');
    expect(markCommandId(Math.random)).toMatch(MARKER_COMMAND_ID_PATTERN);
  });

  it('posts one command and reads its status until the groundstation ran it', async () => {
    const fake = console_({ post: [accepted()], get: [{ status: 200, body: { status: 'queued' } }, { status: 200, body: { status: 'sent' } }, done('OK', 'm-12')] });
    const client = createMirrorMarkClient(fake.env);
    let outcome: MirrorMarkOutcome | null = null;
    void client.add(433_920_000.4).then((value) => { outcome = value; });
    await fake.advance(MIRROR_MARK_POLL_MS * 3);
    expect(outcome).toEqual({ ok: true, code: 'OK', markerId: 'm-12' });
    expect(fake.requests[0]).toEqual({ method: 'POST', path: MIRROR_MARKERS_ROUTE, body: { v: 1, id: 'tab-9999999999999999', op: 'add', frequency_hz: 433_920_000 }, at: 50_000 });
    expect(fake.requests.slice(1).map((request) => [request.method, request.path, request.at - 50_000])).toEqual([
      ['GET', `${MIRROR_MARKERS_ROUTE}/tab-9999999999999999`, MIRROR_MARK_POLL_MS],
      ['GET', `${MIRROR_MARKERS_ROUTE}/tab-9999999999999999`, MIRROR_MARK_POLL_MS * 2],
      ['GET', `${MIRROR_MARKERS_ROUTE}/tab-9999999999999999`, MIRROR_MARK_POLL_MS * 3],
    ]);
  });

  it('removes by the marker id and reports the Receiver\'s code', async () => {
    const fake = console_({ post: [accepted()], get: [done('MARKER_NOT_FOUND', 'm-3')] });
    const outcome = createMirrorMarkClient(fake.env).remove('m-3');
    await fake.advance(MIRROR_MARK_POLL_MS);
    expect(await outcome).toEqual({ ok: false, code: 'MARKER_NOT_FOUND', markerId: 'm-3' });
    expect(fake.requests[0].body).toEqual({ v: 1, id: 'tab-9999999999999999', op: 'remove', marker_id: 'm-3' });
  });

  it('reports the console\'s refusal, and REFUSED for one it does not know', async () => {
    for (const code of MIRROR_MARKER_ERROR_CODES) {
      const fake = console_({ post: [{ status: 409, body: { ok: false, code, error: 'no' } }] });
      expect(await createMirrorMarkClient(fake.env).add(433_920_000)).toEqual({ ok: false, code, markerId: null });
      expect(fake.requests).toHaveLength(1);
    }
    const old = console_({ post: [{ status: 405, body: { ok: false, code: 'LAN_READ_ONLY' } }] });
    expect((await createMirrorMarkClient(old.env).add(433_920_000)).code).toBe('REFUSED');
    const empty = console_({ post: [{ status: 503, body: null }] });
    expect((await createMirrorMarkClient(empty.env).add(433_920_000)).code).toBe('REFUSED');
  });

  it('says NETWORK when the post fails, and keeps reading through dropped status reads', async () => {
    const offline = console_({ post: [new Error('offline')] });
    expect(await createMirrorMarkClient(offline.env).add(433_920_000)).toEqual({ ok: false, code: 'NETWORK', markerId: null });
    const flaky = console_({ post: [accepted()], get: [new Error('dropped'), { status: 503, body: null }, done('OK', 'm-1')] });
    const outcome = createMirrorMarkClient(flaky.env).add(433_920_000);
    await flaky.advance(MIRROR_MARK_POLL_MS * 3);
    expect(await outcome).toEqual({ ok: true, code: 'OK', markerId: 'm-1' });
  });

  it('says EXPIRED when the console expired it, no longer holds it, or nothing settles it in time', async () => {
    const expired = console_({ post: [accepted()], get: [{ status: 200, body: { status: 'expired' } }] });
    const first = createMirrorMarkClient(expired.env).add(433_920_000);
    await expired.advance(MIRROR_MARK_POLL_MS);
    expect((await first).code).toBe('EXPIRED');
    const forgotten = console_({ post: [accepted()], get: [{ status: 404, body: { ok: false, code: 'MIRROR_UNKNOWN_COMMAND' } }] });
    const second = createMirrorMarkClient(forgotten.env).add(433_920_000);
    await forgotten.advance(MIRROR_MARK_POLL_MS);
    expect((await second).code).toBe('EXPIRED');
    const silent = console_({ post: [accepted()] });
    let outcome: MirrorMarkOutcome | null = null;
    void createMirrorMarkClient(silent.env).add(433_920_000).then((value) => { outcome = value; });
    await silent.advance(MIRROR_MARK_WAIT_MS - MIRROR_MARK_POLL_MS);
    expect(outcome).toBeNull();
    await silent.advance(MIRROR_MARK_POLL_MS * 2);
    expect(outcome).toEqual({ ok: false, code: 'EXPIRED', markerId: null });
  });

  it('reads an unknown result code as NOT_READY', async () => {
    const fake = console_({ post: [accepted()], get: [done('SOMETHING_NEW')] });
    const outcome = createMirrorMarkClient(fake.env).add(433_920_000);
    await fake.advance(MIRROR_MARK_POLL_MS);
    expect((await outcome).code).toBe('NOT_READY');
  });
});

/** A client whose commands settle when the test says so. */
function manualClient() {
  const calls: Array<{ op: 'add' | 'remove'; value: number | string; settle: (outcome: MirrorMarkOutcome) => void }> = [];
  const client: MirrorMarkClient = {
    add: (frequencyHz) => new Promise((resolve) => { calls.push({ op: 'add', value: frequencyHz, settle: resolve }); }),
    remove: (markerId) => new Promise((resolve) => { calls.push({ op: 'remove', value: markerId, settle: resolve }); }),
  };
  return { client, calls };
}

const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const marker = (id: string, frequencyHz: number): BridgeMarker => ({ id, frequencyHz, powerDb: null, label: id.toUpperCase() });
const live = (markers: BridgeMarker[] = [], frequencyShiftHz = 0): MirrorMarkContext => ({ blocked: null, frequencyShiftHz, markers });

describe('marking controller', () => {
  it('is off at first; turning it off drops the pick and the last failure', () => {
    const { client } = manualClient();
    const controller = createMirrorMarkController(client);
    expect(controller.getState()).toEqual({ on: false, selectedId: null, pendingHz: null, sending: 0, notice: null });
    controller.select('m-1');
    expect(controller.getState().selectedId).toBeNull();
    controller.toggle();
    controller.select('m-1');
    controller.mark(1, live());
    expect(controller.getState()).toMatchObject({ on: true, selectedId: 'm-1', notice: 'OUT_OF_RANGE' });
    controller.toggle();
    expect(controller.getState()).toMatchObject({ on: false, selectedId: null, notice: null });
  });

  it('sends nothing while off or while the mirror has no live source', () => {
    const { client, calls } = manualClient();
    const controller = createMirrorMarkController(client);
    controller.mark(433_920_000, live());
    controller.toggle();
    for (const blocked of ['mirror.markNoSource', 'mirror.markStale'] as const) {
      controller.mark(433_920_000, { ...live(), blocked });
      controller.remove('m-1', { ...live(), blocked });
    }
    expect(calls).toHaveLength(0);
  });

  it('checks the marker range in device Hz, the Freq Shift removed', () => {
    const { client, calls } = manualClient();
    const controller = createMirrorMarkController(client);
    controller.toggle();
    controller.mark(7_250_000_001, live());
    expect(controller.getState().notice).toBe('OUT_OF_RANGE');
    // With a 125 MHz upconverter, 7.3 GHz displayed is 7.175 GHz on the radio.
    controller.mark(7_300_000_000, live([], 125_000_000));
    expect(calls.map((call) => call.value)).toEqual([7_300_000_000]);
  });

  it('draws a mark on its way, then picks the new marker; a failure shows its code', async () => {
    const { client, calls } = manualClient();
    const controller = createMirrorMarkController(client);
    const seen: number[] = [];
    controller.subscribe(() => seen.push(controller.getState().sending));
    controller.toggle();
    controller.mark(433_920_000, live());
    expect(controller.getState()).toMatchObject({ pendingHz: 433_920_000, sending: 1, notice: null });
    controller.mark(434_000_000, live());
    calls[0].settle({ ok: true, code: 'OK', markerId: 'm-7' });
    await flush();
    // The newest mark is still on its way: its dashed line stays.
    expect(controller.getState()).toMatchObject({ pendingHz: 434_000_000, sending: 1, selectedId: 'm-7' });
    calls[1].settle({ ok: false, code: 'MARKER_LIMIT', markerId: null });
    await flush();
    expect(controller.getState()).toMatchObject({ pendingHz: null, sending: 0, notice: 'MARKER_LIMIT', selectedId: 'm-7' });
    // A marker whose save failed is in the list: it is picked, so Remove is one tap away.
    controller.mark(435_000_000, live());
    calls[2].settle({ ok: false, code: 'MARKER_SAVE_FAILED', markerId: 'm-8' });
    await flush();
    expect(controller.getState()).toMatchObject({ selectedId: 'm-8', notice: 'MARKER_SAVE_FAILED' });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('removes the picked marker, and Ctrl+Z only this viewer\'s last mark still listed', async () => {
    const { client, calls } = manualClient();
    const controller = createMirrorMarkController(client);
    controller.toggle();
    controller.mark(433_000_000, live());
    calls[0].settle({ ok: true, code: 'OK', markerId: 'm-1' });
    controller.mark(434_000_000, live());
    await flush();
    calls[1].settle({ ok: true, code: 'OK', markerId: 'm-2' });
    await flush();
    const listed = [marker('m-0', 432_000_000), marker('m-1', 433_000_000), marker('m-2', 434_000_000)];
    // The operator's marker m-0 is picked and removed by Delete.
    controller.select('m-0');
    controller.key('remove', live(listed));
    expect(calls.at(-1)).toMatchObject({ op: 'remove', value: 'm-0' });
    calls.at(-1)?.settle({ ok: true, code: 'OK', markerId: 'm-0' });
    await flush();
    expect(controller.getState().selectedId).toBeNull();
    // Ctrl+Z: m-2 is no longer listed (removed on the groundstation), so m-1 goes.
    controller.key('undo', live(listed.filter((entry) => entry.id !== 'm-2')));
    expect(calls.at(-1)).toMatchObject({ op: 'remove', value: 'm-1' });
    calls.at(-1)?.settle({ ok: true, code: 'OK', markerId: 'm-1' });
    await flush();
    const count = calls.length;
    controller.key('undo', live([marker('m-0', 432_000_000)]));
    controller.key('remove', live(listed));
    expect(calls).toHaveLength(count);
  });

  it('keeps the pick when a remove fails for another reason than a missing marker', async () => {
    const { client, calls } = manualClient();
    const controller = createMirrorMarkController(client);
    controller.toggle();
    controller.select('m-5');
    controller.remove('m-5', live());
    calls[0].settle({ ok: false, code: 'EXPIRED', markerId: null });
    await flush();
    expect(controller.getState()).toMatchObject({ selectedId: 'm-5', notice: 'EXPIRED', sending: 0 });
  });
});

describe('marking reasons and messages', () => {
  it('blocks marking without a live source and while frames are stale', () => {
    const phases: Record<MirrorPhase, string | null> = {
      connecting: 'mirror.markNoSource', none: 'mirror.markNoSource', lost: 'mirror.markNoSource', stale: 'mirror.markStale',
      live: null, changing: null, stopped: null,
    };
    for (const [phase, reason] of Object.entries(phases)) expect(mirrorMarkBlocked({ phase: phase as MirrorPhase })).toBe(reason);
  });

  it('names every failure in operator words, in both languages', () => {
    const codes: MirrorMarkCode[] = [...MIRROR_MARKER_RESULT_CODES.filter((code) => code !== 'OK'), ...MIRROR_MARKER_ERROR_CODES, 'EXPIRED', 'NETWORK', 'REFUSED'];
    for (const code of codes) {
      const key = mirrorMarkMessage(code);
      for (const lang of ['en', 'id'] as const) {
        const text = translate(lang, key);
        expect(text, `${code} ${lang}`).not.toBe(key);
        expect(text).not.toMatch(/MIRROR_|_ID|NOT_READY/u);
      }
    }
    expect(mirrorMarkMessage('MARKER_LIMIT')).toBe('spectrum.markLimit');
    expect(mirrorMarkMessage('OUT_OF_RANGE')).toBe('spectrum.markOutOfRange');
    expect(mirrorMarkMessage('MIRROR_NO_SOURCE')).toBe('mirror.markNoSource');
    expect(mirrorMarkMessage('MIRROR_MARKER_BUSY')).toBe('mirror.markBusy');
    expect(mirrorMarkMessage('NETWORK')).toBe('mirror.markFailed');
    expect(translate('id', 'mirror.markExpired')).toBe('Groundstation tidak memasang penanda tepat waktu.');
  });
});
