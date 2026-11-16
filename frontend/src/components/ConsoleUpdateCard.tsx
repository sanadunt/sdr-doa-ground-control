import type { JSX } from 'react';
import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { Translate } from '../lib/i18n';
import {
  ConsoleUpdateError, IDLE_POLL_MS, UPDATE_CLOSED, UPDATE_POLL_MS, canSendUpdate, latestErrorKey, readConsoleUpdate,
  requestConsoleUpdate, updateChip, updateErrorKey, updateProgress, updateReasonKey, updateStep,
} from '../lib/consoleUpdate';
import type { ConsoleUpdateView, UpdateProgress, UpdateStatus, UpdateStep } from '../lib/consoleUpdate';
import { readReceiverBusy } from '../lib/hostPower';
import { Card, KeyValueGrid, PageNotice, StatusChip } from './page';
import type { KeyValueItem, PageTone } from './page';

/** As for Restart and Shutdown: past this the Receiver's state counts as unknown. */
const HEALTH_TIMEOUT_MS = 6_000;
/** The page reloads this long after the new version answered, so the result is read first. */
const RELOAD_DELAY_MS = 1_500;

function timeText(ms: number | null, lang: string): string {
  if (ms === null) return '';
  return new Date(ms).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

const DONE_TONES: Record<string, PageTone> = {
  ok: 'good', up_to_date: 'good', not_updated: 'warn', rolled_back: 'bad', failed: 'bad', dry_run: 'info', queued: 'warn', running: 'warn',
};

function lastUpdateItem(status: UpdateStatus | null, t: Translate, lang: string): KeyValueItem {
  if (!status) return { id: 'last', label: t('update.last'), value: t('update.none'), mono: false };
  const when = timeText(status.finishedAtMs ?? status.startedAtMs ?? status.queuedAtMs, lang);
  const state = status.stale ? t('update.state.failed') : t(`update.state.${status.state}`);
  const version = status.to && status.state === 'ok' ? ` · ${status.to}` : '';
  return {
    id: 'last',
    label: t('update.last'),
    value: when ? t('update.at', { state: `${state}${version}`, time: when }) : `${state}${version}`,
    tone: status.stale ? 'bad' : DONE_TONES[status.state],
    mono: false,
    title: status.message ?? undefined,
  };
}

function latestItem(view: ConsoleUpdateView | null, t: Translate): KeyValueItem {
  const label = t('update.latest');
  if (!view) return { id: 'latest', label, value: t('update.checking'), mono: false };
  const { latest } = view;
  if (latest.state === 'off') return { id: 'latest', label, value: t('update.latestOff'), mono: false };
  if (latest.state === 'error' || !latest.version) {
    return { id: 'latest', label, value: t(latestErrorKey(latest.code), { major: latest.major ?? '—' }), tone: 'warn', mono: false };
  }
  const value = view.updateAvailable ? t('update.latestNew', { version: latest.version }) : latest.version;
  return {
    id: 'latest',
    label,
    value: latest.url ? <a href={latest.url} target="_blank" rel="noreferrer noopener">{value}</a> : value,
    tone: view.updateAvailable ? 'signal' : undefined,
  };
}

/** The line under the rows: the update on its way, or how this page's update ended. */
function ProgressLine({ progress, view, t }: { progress: UpdateProgress; view: ConsoleUpdateView | null; t: Translate }): JSX.Element | null {
  if (progress.kind === 'none') return null;
  if (progress.kind === 'waitingHelper') {
    return progress.slow
      ? <PageNotice tone="warn" title="HELPER">{t('update.progress.waitingSlow')}</PageNotice>
      : <p className="cfg-update-progress" role="status"><span className="cfg-update-spinner" aria-hidden="true" />{t('update.progress.waiting')}</p>;
  }
  if (progress.kind === 'running') {
    return <p className="cfg-update-progress" role="status"><span className="cfg-update-spinner" aria-hidden="true" />{t(progress.label)}</p>;
  }
  const reason = progress.message ? <span className="cfg-update-reason">{t('update.reason', { message: progress.message })}</span> : null;
  switch (progress.state) {
    case 'ok':
      return <PageNotice tone="good" title="OK">{progress.reload ? t('update.progress.reloading', { version: progress.to ?? '' }) : t('update.result.ok', { version: progress.to ?? view?.installed ?? '' })}</PageNotice>;
    case 'up_to_date': {
      const latest = view?.latest.version;
      return (
        <PageNotice tone="info" title="UP TO DATE">
          {view?.updateAvailable && latest ? t('update.result.notPublished', { version: latest }) : t('update.result.up_to_date')}
        </PageNotice>
      );
    }
    case 'dry_run':
      return <PageNotice tone="info" title="DRY-RUN">{t('update.state.dry_run')}</PageNotice>;
    case 'not_updated':
      return <PageNotice tone="warn" title="NOT UPDATED">{t('update.state.not_updated')} {reason}</PageNotice>;
    case 'rolled_back':
      return <PageNotice tone="bad" title="ROLLED BACK">{t('update.result.rolled_back')} {reason}</PageNotice>;
    default:
      return <PageNotice tone="bad" title="FAILED">{t('update.result.failed')} {reason}</PageNotice>;
  }
}

/** The confirm box: Cancel first with the focus; Update waits for the Receiver's state. */
export function ConsoleUpdateConfirm({ step, view, t, onCancel, onSend, titleId, effectId }: {
  step: Extract<UpdateStep, { stage: 'confirm' | 'sending' }>;
  view: ConsoleUpdateView | null;
  t: Translate;
  onCancel: () => void;
  onSend: () => void;
  titleId: string;
  effectId: string;
}): JSX.Element {
  const target = view?.updateAvailable ? view.latest.version : null;
  return (
    <div className="cfg-update-confirm" role="alertdialog" aria-labelledby={titleId} aria-describedby={effectId}>
      <h3 id={titleId}>{target ? t('update.confirmTo', { version: target }) : t('update.confirm')}</h3>
      <p id={effectId}>{t('update.effect')}</p>
      {view?.latest.code === 'OFFLINE' ? <p className="cfg-warn">{t('update.offlineNote')}</p> : null}
      {step.busy === 'busy' ? <p className="cfg-update-warning" role="alert">{t('update.busy')}</p> : null}
      {step.busy === 'checking' ? <p className="cfg-update-note">{t('power.busyChecking')}</p> : null}
      {step.busy === 'unknown' ? <p className="cfg-update-note">{t('power.busyUnknown')}</p> : null}
      <div className="cfg-actions">
        <button className="ov-button" type="button" autoFocus disabled={step.stage === 'sending'} onClick={onCancel}>{t('power.cancel')}</button>
        <button className="ov-button is-primary" type="button" disabled={!canSendUpdate(step)} onClick={onSend}>
          {step.stage === 'sending' ? t('update.sending') : t('update.button')}
        </button>
      </div>
    </div>
  );
}

/**
 * Configuration's Update card, on the console's own page only. It reads GET
 * /api/host/update (every minute, every 1.5 s while an update runs), and its
 * Update button opens a confirm box that warns when the Receiver records.
 * After the request it follows the helper's state through the console's
 * restart and reloads the page once the new version answers.
 */
export function ConsoleUpdateCard({ initialView = null, initialStep = UPDATE_CLOSED }: {
  /** The first state, for a static render; the card reads /api/host/update itself otherwise. */
  initialView?: ConsoleUpdateView | null;
  initialStep?: UpdateStep;
}): JSX.Element {
  const { t, lang } = useI18n();
  const ids = useId();
  const [view, setView] = useState<ConsoleUpdateView | null>(initialView);
  const [reachable, setReachable] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [step, dispatch] = useReducer(updateStep, initialStep);
  const [now, setNow] = useState(() => Date.now());
  // The version this page's code belongs to: a newer one answering means the page is out of date.
  const pageVersion = useRef<string | null>(initialView?.installed ?? null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const healthRef = useRef<AbortController | null>(null);
  const sendRef = useRef<AbortController | null>(null);

  const progress = updateProgress(view, step, reachable, now);
  // This page's request until it ended, or an update the page found on its way.
  const running = progress.kind === 'running' || progress.kind === 'waitingHelper';

  const read = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    try {
      const next = await readConsoleUpdate(refresh, signal);
      if (signal?.aborted) return;
      if (pageVersion.current === null) pageVersion.current = next.installed;
      setView(next);
      setReachable(true);
      setReadFailed(false);
    } catch {
      if (signal?.aborted) return;
      setReachable(false);
      setReadFailed(true);
    } finally {
      if (!signal?.aborted) setNow(Date.now());
    }
  }, []);

  // A setTimeout chain: fast while an update is on its way, else once a minute.
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const loop = async () => {
      await read(false, controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(() => { void loop(); }, running ? UPDATE_POLL_MS : IDLE_POLL_MS);
    };
    void loop();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [read, running]);

  useEffect(() => () => {
    healthRef.current?.abort();
    sendRef.current?.abort();
  }, []);

  const reload = progress.kind === 'done' && progress.reload;
  useEffect(() => {
    if (!reload) return undefined;
    const timer = window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const close = useCallback(() => {
    healthRef.current?.abort();
    healthRef.current = null;
    dispatch({ type: 'cancel' });
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  const open = () => {
    dispatch({ type: 'open' });
    healthRef.current?.abort();
    const controller = new AbortController();
    healthRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    readReceiverBusy(controller.signal).then(
      (busy) => { if (healthRef.current === controller) dispatch({ type: 'health', busy }); },
      () => { if (healthRef.current === controller) dispatch({ type: 'health', busy: 'unknown' }); },
    ).finally(() => window.clearTimeout(timer));
  };

  const send = () => {
    if (!canSendUpdate(step)) return;
    dispatch({ type: 'send' });
    const fromVersion = view?.installed ?? pageVersion.current ?? '';
    const controller = new AbortController();
    sendRef.current = controller;
    requestConsoleUpdate(controller.signal).then(
      (requestedAtMs) => {
        dispatch({ type: 'sent', requestedAtMs, fromVersion });
        void read(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ConsoleUpdateError) dispatch({ type: 'refused', code: error.code, reason: error.reason, message: error.message });
        else dispatch({ type: 'refused', code: null, message: t('update.error.network') });
      },
    );
  };

  const confirmOpen = step.stage === 'confirm' || step.stage === 'sending';
  useEffect(() => {
    if (!confirmOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmOpen, close]);

  const checkAgain = async () => {
    setChecking(true);
    await read(true);
    setChecking(false);
  };

  const helper = view?.helper ?? null;
  const chip = updateChip(view, progress);
  const items: KeyValueItem[] = [
    { id: 'installed', label: t('update.installed'), value: view?.installed ?? '—' },
    latestItem(view, t),
    {
      id: 'helper',
      label: t('update.helper'),
      value: !helper ? '—' : helper.available ? t('update.helperReady') : t(updateReasonKey(helper.reason)),
      tone: helper && !helper.available ? 'warn' : undefined,
      mono: false,
    },
    lastUpdateItem(view?.status ?? null, t, lang),
  ];
  const refusal = step.stage === 'refused' ? updateErrorKey(step.code) : null;
  const outdated = view && pageVersion.current && view.installed !== pageVersion.current && step.stage !== 'waiting';

  return (
    <Card id="update-settings" span={6} className="cfg-section" title={t('update.title')} chip={<StatusChip code={chip.code} tone={chip.tone} />}>
      {readFailed && !running ? <PageNotice tone="warn" title="ERROR">{t('update.readFailed')}</PageNotice> : null}
      {outdated ? (
        <PageNotice
          tone="info"
          title="RELOAD"
          action={<button className="ov-button" type="button" onClick={() => window.location.reload()}>{t('update.reload')}</button>}
        >
          {t('update.newerRunning', { version: view.installed })}
        </PageNotice>
      ) : null}
      <KeyValueGrid columns={2} items={items} />
      <ProgressLine progress={progress} view={view} t={t} />
      {confirmOpen ? (
        <ConsoleUpdateConfirm step={step} view={view} t={t} onCancel={close} onSend={send} titleId={`${ids}-title`} effectId={`${ids}-effect`} />
      ) : null}
      {step.stage === 'refused' ? (
        <PageNotice tone="bad" title={step.code ?? 'ERROR'}>
          {t('update.failed', { error: refusal ? t(refusal) : step.message })}
          {step.reason ? ` (${t(updateReasonKey(step.reason))})` : ''}
        </PageNotice>
      ) : null}
      <div className="cfg-actions">
        <button
          ref={buttonRef}
          className={view?.updateAvailable ? 'ov-button is-primary' : 'ov-button'}
          type="button"
          disabled={!helper?.available || running || confirmOpen}
          aria-haspopup="dialog"
          aria-expanded={confirmOpen}
          title={helper && !helper.available ? t(updateReasonKey(helper.reason)) : undefined}
          onClick={open}
        >
          {t('update.button')}
        </button>
        <button className="ov-button" type="button" disabled={checking || running} aria-busy={checking || undefined} onClick={() => { void checkAgain(); }}>
          {t('update.check')}
        </button>
      </div>
    </Card>
  );
}
