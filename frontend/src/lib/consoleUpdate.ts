/**
 * Configuration's Update: the installed and newest console versions, and an
 * update of the groundstation's Docker install from the page.
 *
 * The console's own page only (access "local"; the LAN view never shows the
 * card and its listener refuses both routes). GET /api/host/update answers
 * the installed version, the newest stable release of that major version on
 * GitHub (or why there is none: no internet, a rate limit), whether the host
 * helper can update, and the last update's state, which the helper keeps in
 * the request directory. POST /api/host/update writes the request; the host
 * runs sdr-doa-docker update, which restarts the console, so the page keeps
 * reading through the restart and reloads itself once the new version answers.
 *
 * The constants repeat tools/host_power.py and tools/console_release.py
 * (tools/test_host_update.py compares them); every reason, code, state and
 * phase has an EN and ID text.
 */
import type { MessageKey } from './i18n';
import type { ReceiverBusy } from './hostPower';

export const CONSOLE_UPDATE_ROUTE = '/api/host/update';
/** Why Update is disabled: the host power reasons, a console outside Docker, or a host side without the update. */
export const CONSOLE_UPDATE_REASONS = [
  'NOT_CONFIGURED', 'DIR_NOT_MOUNTED', 'DIR_MISSING', 'DIR_NOT_WRITABLE', 'HELPER_MISSING', 'NOT_DOCKER', 'UPDATE_HELPER_MISSING',
] as const;
export type ConsoleUpdateReason = typeof CONSOLE_UPDATE_REASONS[number];
export const CONSOLE_UPDATE_ERROR_CODES = [
  'ORIGIN_REJECTED', 'HOST_UPDATE_INVALID', 'HOST_UPDATE_TOO_LARGE', 'HOST_UPDATE_CONFIRM_REQUIRED', 'HOST_UPDATE_UNAVAILABLE',
  'HOST_UPDATE_PENDING', 'HOST_UPDATE_RUNNING', 'HOST_UPDATE_WRITE_FAILED',
] as const;
export type ConsoleUpdateErrorCode = typeof CONSOLE_UPDATE_ERROR_CODES[number];
/** The helper's states; queued and running while an update is on its way. */
export const CONSOLE_UPDATE_STATES = ['queued', 'running', 'ok', 'up_to_date', 'not_updated', 'rolled_back', 'failed', 'dry_run'] as const;
export type ConsoleUpdateState = typeof CONSOLE_UPDATE_STATES[number];
export const CONSOLE_UPDATE_PHASES = ['preparing', 'pulling', 'starting', 'rolling_back'] as const;
export type ConsoleUpdatePhase = typeof CONSOLE_UPDATE_PHASES[number];
/** Why no newest version shows. */
export const RELEASE_CHECK_CODES = ['OFFLINE', 'RATE_LIMITED', 'HTTP_ERROR', 'INVALID_ANSWER', 'NO_RELEASE'] as const;
export type ReleaseCheckCode = typeof RELEASE_CHECK_CODES[number];
/** A queued or running state older than this outlived the update unit (tools/host_power.py UPDATE_STALE_S). */
export const UPDATE_STALE_MS = 3_600_000;
/** Reads while an update is on its way, and otherwise. */
export const UPDATE_POLL_MS = 1_500;
export const IDLE_POLL_MS = 60_000;
/** The helper takes a request within a second or two; past this the card says where to look. */
export const HELPER_TAKE_MS = 20_000;
/** A state counts as the answer to this page's request when it is no older than the request (same host clock). */
const REQUEST_SLACK_MS = 2_000;
/** After an ok, how long the page waits for a new version before it shows the result as it is. */
const SAME_VERSION_WAIT_MS = 30_000;

export interface UpdateStatus {
  state: ConsoleUpdateState;
  phase: ConsoleUpdatePhase | null;
  queuedAtMs: number | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  to: string | null;
  message: string | null;
  stale: boolean;
}

export interface LatestRelease {
  state: 'ok' | 'error' | 'off';
  version: string | null;
  url: string | null;
  code: ReleaseCheckCode | null;
  major: number | null;
}

export interface ConsoleUpdateView {
  installed: string;
  latest: LatestRelease;
  updateAvailable: boolean;
  helper: { available: boolean; reason: ConsoleUpdateReason | null };
  status: UpdateStatus | null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/u;

function versionText(value: unknown): string | null {
  return typeof value === 'string' && VERSION_RE.test(value) ? value : null;
}

function normalizeStatus(value: unknown): UpdateStatus | null {
  const item = record(value);
  const state = item ? oneOf(CONSOLE_UPDATE_STATES, item.state) : null;
  if (!item || !state) return null;
  return {
    state,
    phase: oneOf(CONSOLE_UPDATE_PHASES, item.phase),
    queuedAtMs: finiteMs(item.queued_at_ms),
    startedAtMs: finiteMs(item.started_at_ms),
    finishedAtMs: finiteMs(item.finished_at_ms),
    to: versionText(item.to),
    message: typeof item.message === 'string' && item.message.length <= 300 ? item.message : null,
    stale: item.stale === true,
  };
}

/** GET /api/host/update; null for an answer of another shape. */
export function normalizeConsoleUpdate(value: unknown): ConsoleUpdateView | null {
  const body = record(value);
  const latest = record(body?.latest);
  const helper = record(body?.helper);
  if (!body || body.ok !== true || typeof body.installed !== 'string' || !latest || !helper || typeof helper.available !== 'boolean') return null;
  const latestState = latest.state === 'ok' || latest.state === 'error' ? latest.state : 'off';
  const version = latestState === 'ok' ? versionText(latest.version) : null;
  return {
    installed: body.installed.slice(0, 64),
    latest: {
      state: latestState === 'ok' && !version ? 'error' : latestState,
      version,
      url: typeof latest.url === 'string' && latest.url.startsWith('https://github.com/') ? latest.url : null,
      code: oneOf(RELEASE_CHECK_CODES, latest.code),
      major: typeof latest.major === 'number' && Number.isInteger(latest.major) ? latest.major : null,
    },
    updateAvailable: body.update_available === true && version !== null,
    helper: helper.available
      ? { available: true, reason: null }
      : { available: false, reason: oneOf(CONSOLE_UPDATE_REASONS, helper.reason) },
    status: normalizeStatus(body.status),
  };
}

/** An update on its way per the helper's state (queued or running, not past the unit's timeout). */
export function updateRunning(status: UpdateStatus | null): boolean {
  return status !== null && (status.state === 'queued' || status.state === 'running') && !status.stale;
}

/** The confirm step and this page's own request. */
export type UpdateStep =
  | { stage: 'closed' }
  | { stage: 'confirm'; busy: ReceiverBusy }
  | { stage: 'sending'; busy: ReceiverBusy }
  /** Sent: the page follows the helper's state and the console's restart. */
  | { stage: 'waiting'; requestedAtMs: number; fromVersion: string }
  | { stage: 'refused'; code: ConsoleUpdateErrorCode | null; reason: ConsoleUpdateReason | null; message: string };

export type UpdateEvent =
  | { type: 'open' }
  | { type: 'health'; busy: Exclude<ReceiverBusy, 'checking'> }
  | { type: 'send' }
  | { type: 'sent'; requestedAtMs: number; fromVersion: string }
  | { type: 'refused'; code: string | null; reason?: unknown; message: string }
  | { type: 'cancel' };

export const UPDATE_CLOSED: UpdateStep = { stage: 'closed' };

export function updateStep(step: UpdateStep, event: UpdateEvent): UpdateStep {
  switch (event.type) {
    case 'open':
      // The card offers Update again only once this page's update ended.
      return step.stage === 'sending' ? step : { stage: 'confirm', busy: 'checking' };
    case 'health':
      return step.stage === 'confirm' || step.stage === 'sending' ? { ...step, busy: event.busy } : step;
    case 'send':
      return step.stage === 'confirm' && step.busy !== 'checking' ? { stage: 'sending', busy: step.busy } : step;
    case 'sent':
      return step.stage === 'sending' ? { stage: 'waiting', requestedAtMs: event.requestedAtMs, fromVersion: event.fromVersion } : step;
    case 'refused':
      return step.stage === 'sending'
        ? { stage: 'refused', code: oneOf(CONSOLE_UPDATE_ERROR_CODES, event.code), reason: oneOf(CONSOLE_UPDATE_REASONS, event.reason), message: event.message }
        : step;
    case 'cancel':
      return step.stage === 'sending' || step.stage === 'waiting' ? step : UPDATE_CLOSED;
    default:
      return step;
  }
}

export function canSendUpdate(step: UpdateStep): boolean {
  return step.stage === 'confirm' && step.busy !== 'checking';
}

/** What the card shows of an update: nothing, its way through, or how it ended. */
export type UpdateProgress =
  | { kind: 'none' }
  | { kind: 'waitingHelper'; slow: boolean }
  | { kind: 'running'; label: MessageKey }
  | { kind: 'done'; state: ConsoleUpdateState; to: string | null; message: string | null; reload: boolean };

function stateTime(status: UpdateStatus): number {
  return Math.max(status.queuedAtMs ?? 0, status.startedAtMs ?? 0);
}

function runningLabel(status: UpdateStatus): MessageKey {
  if (status.state === 'queued') return 'update.state.queued';
  return `update.phase.${status.phase ?? 'preparing'}` as MessageKey;
}

/**
 * The progress of this page's request (step waiting), or of an update the
 * page found running. `reachable` is false while reads fail: the console is
 * restarting. A new installed version ends the wait even when the helper's
 * state cannot be read.
 */
export function updateProgress(view: ConsoleUpdateView | null, step: UpdateStep, reachable: boolean, nowMs: number): UpdateProgress {
  const status = view?.status ?? null;
  if (step.stage !== 'waiting') {
    return status && updateRunning(status) ? { kind: 'running', label: runningLabel(status) } : { kind: 'none' };
  }
  if (view && view.installed !== step.fromVersion) {
    return { kind: 'done', state: 'ok', to: view.installed, message: null, reload: true };
  }
  if (!reachable) return { kind: 'running', label: 'update.progress.restarting' };
  const mine = status !== null && stateTime(status) >= step.requestedAtMs - REQUEST_SLACK_MS ? status : null;
  if (!mine) return { kind: 'waitingHelper', slow: nowMs - step.requestedAtMs > HELPER_TAKE_MS };
  if (mine.state === 'queued' || mine.state === 'running') {
    return mine.stale ? { kind: 'done', state: 'failed', to: mine.to, message: null, reload: false } : { kind: 'running', label: runningLabel(mine) };
  }
  // ok while this page still reads the old version: the new console answers in a
  // moment. An ok that kept the version (the same image, restarted) ends the wait.
  if (mine.state === 'ok' && nowMs - (mine.finishedAtMs ?? nowMs) <= SAME_VERSION_WAIT_MS) {
    return { kind: 'running', label: 'update.progress.restarting' };
  }
  return { kind: 'done', state: mine.state, to: mine.to, message: mine.message, reload: false };
}

/** The card's chip: a status code (untranslated) and its tone. */
export function updateChip(view: ConsoleUpdateView | null, progress: UpdateProgress): { code: string; tone: 'good' | 'warn' | 'bad' | 'neutral' | 'signal' } {
  if (progress.kind === 'running' || progress.kind === 'waitingHelper') return { code: 'UPDATING', tone: 'warn' };
  if (!view) return { code: 'CHECKING', tone: 'neutral' };
  if (view.updateAvailable) return { code: 'UPDATE AVAILABLE', tone: 'signal' };
  if (view.latest.state === 'ok') return { code: 'UP TO DATE', tone: 'good' };
  if (view.latest.code === 'OFFLINE') return { code: 'OFFLINE', tone: 'neutral' };
  return { code: 'UNKNOWN', tone: 'neutral' };
}

export function updateReasonKey(reason: ConsoleUpdateReason | null): MessageKey {
  return reason ? `update.reason.${reason}` as MessageKey : 'update.reason.unknown';
}

export function updateErrorKey(code: ConsoleUpdateErrorCode | null): MessageKey | null {
  return code ? `update.error.${code}` as MessageKey : null;
}

export function latestErrorKey(code: ReleaseCheckCode | null): MessageKey {
  return code ? `update.latestError.${code}` as MessageKey : 'update.latestError.HTTP_ERROR';
}

export class ConsoleUpdateError extends Error {
  readonly code: string | null;
  readonly reason: unknown;
  constructor(message: string, code: string | null, reason: unknown) {
    super(message);
    this.name = 'ConsoleUpdateError';
    this.code = code;
    this.reason = reason;
  }
}

/** GET /api/host/update; `refresh` asks the console to read GitHub again (at most every 15 s). */
export async function readConsoleUpdate(refresh: boolean, signal?: AbortSignal): Promise<ConsoleUpdateView> {
  const response = await fetch(refresh ? `${CONSOLE_UPDATE_ROUTE}?refresh=1` : CONSOLE_UPDATE_ROUTE, {
    cache: 'no-store', credentials: 'same-origin', signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const view = normalizeConsoleUpdate(await response.json());
  if (!view) throw new Error('unexpected update answer');
  return view;
}

/** POST /api/host/update with confirm: true; resolves with the request time on 202. */
export async function requestConsoleUpdate(signal?: AbortSignal): Promise<number> {
  const response = await fetch(CONSOLE_UPDATE_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ confirm: true }),
    signal,
  });
  let body: Record<string, unknown> = {};
  try {
    body = record(await response.json()) ?? {};
  } catch {
    // An answer without JSON keeps only its status.
  }
  if (response.status === 202) {
    const at = finiteMs(body.requested_at_ms);
    return at ?? Date.now();
  }
  const code = typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(body.code) ? body.code : null;
  const message = typeof body.error === 'string' && body.error.length <= 400 ? body.error : `HTTP ${response.status}`;
  throw new ConsoleUpdateError(message, code, body.reason);
}
