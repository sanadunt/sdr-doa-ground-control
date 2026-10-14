import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getAdminStatus, getConfigPatchStatus, getConfigReported, logoutAdmin, sendConfigPatch } from '../../api';
import type { ConfigCommandStatus, ConfigReported, ConsoleCapabilities } from '../../api';
import type { ConfigPatchChanges, ConfigPatchKey, ControlDraftRequest } from '../../lib/controlDraft';
import {
  CONFIG_PATCH_ERROR_KEYS,
  CONFIG_PATCH_FIELDS,
  commandResultView,
  displayValue,
  draftFromReported,
  isConfigPatchErrorCode,
  mergeIntoDraft,
  parseDraft,
  rangeParts,
} from '../../lib/configPatch';
import type { CommandResultView, ConfigPatchRanges, DraftEvaluation, DraftValues, FieldEvaluation } from '../../lib/configPatch';
import { errorNotice, noticeText } from '../../lib/errorNotice';
import type { Notice } from '../../lib/errorNotice';
import { useI18n } from '../../lib/i18n';
import type { MessageKey, Translate } from '../../lib/i18n';
import { AdminUnlock } from '../AdminUnlock';
import { Icon } from '../ui';

export interface ControlPanelProps {
  capabilities: ConsoleCapabilities | null;
  /** Latest draft from the spectrum dock; a new `seq` means a new request. */
  controlDraftRequest: ControlDraftRequest | null;
  onClose: () => void;
}

export type ControlAdminState = 'checking' | 'locked' | 'unlocked';
export type ControlStage = 'edit' | 'review' | 'sending' | 'done';

export interface ControlReviewRow { key: ConfigPatchKey; label: string; from: string; to: string }
/** What the operator reviewed: exactly these changes, against this base revision. */
export interface ControlReview { changes: ConfigPatchChanges; rev: number | null; rows: ControlReviewRow[] }
export interface ControlSending { commandId: string | null; count: number; baseRev: number | null; status: ConfigCommandStatus | null }
export interface ControlFailure { code: string; message: Notice }
export interface ControlDone {
  view: CommandResultView | null;
  error: ControlFailure | null;
  commandId: string | null;
  restarted: boolean;
}

/** Topic suffix shown before the server reports the full topic. */
const PATCH_TOPIC_SUFFIX = 'cmd/config/patch';
const ACK_TOPIC_SUFFIX = 'ack/config';
const REPORTED_POLL_MS = 2_000;
const STATUS_POLL_MS = 1_000;
const DEFAULT_TTL_MS = 60_000;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;

// The spectrum dock's request that was already merged. Module scope, so a
// panel opened again later does not replay an old request.
let lastConsumedDraftSeq = 0;

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Interpolate a message whose placeholders become monospace elements (topics, ids, flags). */
function withSlots(template: string, slots: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/u).map((part, index) => {
    const name = /^\{(\w+)\}$/u.exec(part)?.[1];
    return name && name in slots ? <span key={index} className="ov-mono">{slots[name]}</span> : part;
  });
}

/** Translate a failed console request by its stable error code. */
export function controlFailure(error: unknown): ControlFailure {
  if (error instanceof ApiError && error.code) {
    return {
      code: error.code,
      message: isConfigPatchErrorCode(error.code) ? { key: CONFIG_PATCH_ERROR_KEYS[error.code] } : { key: 'control.error.unknown', vars: { error: error.message } },
    };
  }
  return { code: error instanceof ApiError ? `HTTP ${error.status}` : 'REQUEST_FAILED', message: errorNotice(error, 'common.requestFailed') };
}

type HintTone = 'neutral' | 'changed' | 'error';

/** The line under a field: an input error, the reported value it changes, or "not reported"; nothing otherwise. */
function fieldHint(t: Translate, evaluation: FieldEvaluation, ranges: ConfigPatchRanges | null): { text: string; tone: HintTone } | null {
  const range = t('control.range', rangeParts(evaluation.field, ranges));
  if (evaluation.problem === 'number') return { text: t('control.notNumber'), tone: 'error' };
  if (evaluation.problem === 'range') return { text: t('control.outOfRange', { range }), tone: 'error' };
  if (evaluation.problem === 'empty') return { text: t('control.required', { range }), tone: 'error' };
  if (evaluation.changed) {
    const from = evaluation.reported === null ? t('control.notReported') : displayValue(evaluation.field, evaluation.reported);
    return { text: t('control.changedFrom', { value: from }), tone: 'changed' };
  }
  if (evaluation.reported === null && evaluation.text.trim() === '') return { text: t('control.notReported'), tone: 'neutral' };
  return null;
}

/** Rows of the review box: label, contract key, reported value and new value. */
export function reviewRows(t: Translate, fields: readonly FieldEvaluation[]): ControlReviewRow[] {
  return fields.filter((field) => field.changed && field.value !== null).map((field) => ({
    key: field.field.key,
    label: t(field.field.shortLabel),
    from: field.reported === null ? t('control.notReported') : displayValue(field.field, field.reported),
    to: displayValue(field.field, field.value),
  }));
}

export interface ControlPanelViewProps {
  capabilities: ConsoleCapabilities | null;
  admin: ControlAdminState;
  adminNotice: Notice | null;
  reported: ConfigReported | null;
  reportedError: Notice | null;
  evaluation: DraftEvaluation;
  stage: ControlStage;
  review: ControlReview | null;
  sending: ControlSending | null;
  done: ControlDone | null;
  editError: ControlFailure | null;
  onClose: () => void;
  onLock: () => void;
  onUnlocked: () => void;
  onDraftChange: (key: ConfigPatchKey, text: string) => void;
  onReview: () => void;
  onReset: () => void;
  onSend: () => void;
  onBack: () => void;
  onDone: () => void;
  onReload: () => void;
}

/** Kontrol markup for one state; ControlPanel owns the state and the requests. */
export function ControlPanelView({
  capabilities,
  admin,
  adminNotice,
  reported,
  reportedError,
  evaluation,
  stage,
  review,
  sending,
  done,
  editError,
  onClose,
  onLock,
  onUnlocked,
  onDraftChange,
  onReview,
  onReset,
  onSend,
  onBack,
  onDone,
  onReload,
}: ControlPanelViewProps): JSX.Element {
  const { t } = useI18n();
  const patch = capabilities?.configPatch ?? null;
  const ranges = patch?.ranges ?? null;
  const topic = patch?.topic ?? PATCH_TOPIC_SUFFIX;
  const ackTopic = patch?.topic ? patch.topic.replace(/cmd\/config\/patch$/u, ACK_TOPIC_SUFFIX) : ACK_TOPIC_SUFFIX;
  const ttlS = Math.round((patch?.ttlMs ?? DEFAULT_TTL_MS) / 1000);
  const qos = patch?.qos ?? 1;
  const unlocked = admin === 'unlocked';
  const defaultPassword = capabilities?.adminDefaultPassword === true;
  const changeCount = Object.keys(evaluation.changes).length;
  const patchUnavailable = patch?.enabled === false || (reported !== null && !reported.available);
  const connected = reported?.broker.connection === 'connected';
  const baseRev = reported?.baseConfigRev ?? null;
  const brokerText = reported?.broker.host ? `${reported.broker.host}${reported.broker.port ? `:${reported.broker.port}` : ''}` : '—';
  const ageMs = reported?.reported?.ageMs ?? null;
  const reviewBlocked: MessageKey | null = !review ? null
    : patchUnavailable ? 'control.patchUnavailable'
      : review.rev === null ? 'control.sendBlockedRev'
        : !connected ? 'control.sendBlockedBroker' : null;

  let body: ReactNode;
  if (!unlocked) {
    body = admin === 'checking' ? <p className="ov-control-note" role="status">{t('control.checking')}</p> : (
      <AdminUnlock disabled={capabilities?.adminEnabled === false} defaultPassword={defaultPassword} notice={adminNotice} onUnlocked={onUnlocked} />
    );
  } else {
    body = (
      <>
        {defaultPassword ? <p className="ov-control-warn" role="note">{t('control.defaultPassword')}</p> : null}
        <div className="ov-control-meta">
          <span className="ov-mono ov-control-topic">{topic}</span>
          <span>{withSlots(t('control.broker'), { broker: brokerText, connection: (reported?.broker.connection ?? 'unknown').toUpperCase(), rev: baseRev ?? t('control.revUnknown') })}</span>
          <span>
            {reported?.reported
              ? t('control.reportedAge', { age: ageMs === null ? '—' : t('common.durationS', { value: Number((ageMs / 1000).toFixed(1)) }) })
              : t('control.reportedNone')}
            {reported?.reported?.synthetic ? <> <span className="ov-tag tone-warn">SYNTHETIC</span></> : null}
          </span>
        </div>
        {reportedError ? <p className="ov-control-error" role="alert">{t('control.readFailed', { error: noticeText(t, reportedError) })}</p> : null}
        {patchUnavailable ? (
          <p className="ov-control-warn">{reported?.code && isConfigPatchErrorCode(reported.code) ? t(CONFIG_PATCH_ERROR_KEYS[reported.code]) : t('control.patchUnavailable')}</p>
        ) : null}
        {!reported && !reportedError ? <p className="ov-control-note" role="status">{t('control.loading')}</p> : null}

        {stage === 'edit' ? (
          <>
            <div className="ov-control-fields">
              {evaluation.fields.map((entry) => {
                const hint = fieldHint(t, entry, ranges);
                const inputId = `ov-control-${entry.field.key}`;
                const hintId = hint ? `${inputId}-hint` : undefined;
                return (
                  <div className="ov-control-field" key={entry.field.key}>
                    <label htmlFor={inputId}>{t(entry.field.shortLabel)}</label>
                    <div className={`ov-unit-input${hint?.tone === 'error' ? ' is-error' : hint?.tone === 'changed' ? ' is-changed' : ''}`}>
                      <input
                        id={inputId}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        spellCheck={false}
                        value={entry.text}
                        disabled={!reported}
                        aria-invalid={hint?.tone === 'error' ? true : undefined}
                        aria-describedby={hintId}
                        onChange={(event) => onDraftChange(entry.field.key, event.target.value)}
                      />
                      <span>{entry.field.unit}</span>
                    </div>
                    {hint ? <small id={hintId} className={`ov-control-hint is-${hint.tone}`}>{hint.text}</small> : null}
                  </div>
                );
              })}
            </div>
            {editError ? <p className="ov-control-error" role="alert">{noticeText(t, editError.message)}</p> : null}
            <div className="ov-control-actions">
              <button className="ov-button is-primary is-wide" type="button" disabled={!reported || patchUnavailable || evaluation.invalid || changeCount === 0} onClick={onReview}>{t('control.review')}</button>
              <button className="ov-button" type="button" onClick={onReset}>{t('control.reset')}</button>
            </div>
          </>
        ) : null}

        {stage === 'review' && review ? (
          <>
            <div className="ov-control-review">
              <strong>{t('control.reviewTitle', { count: review.rows.length })}</strong>
              {review.rows.map((row) => (
                <div className="ov-control-change" key={row.key}>
                  <span>{row.label} <span className="ov-mono ov-control-key">{row.key}</span></span>
                  <span className="ov-mono">{row.from} → <b>{row.to}</b></span>
                </div>
              ))}
              <span className="ov-control-review-meta">{t('control.reviewMeta', { qos, ttl: ttlS, rev: review.rev ?? t('control.revUnknown') })}</span>
            </div>
            {/* An unavailable publish path is already named above the form. */}
            {reviewBlocked && !patchUnavailable ? <p className="ov-control-warn">{t(reviewBlocked)}</p> : null}
            <div className="ov-control-actions">
              <button className="ov-button is-send is-wide" type="button" disabled={reviewBlocked !== null} onClick={onSend}>
                <Icon name="send" /><span>{t('control.send')}</span>
              </button>
              <button className="ov-button" type="button" onClick={onBack}>{t('control.back')}</button>
            </div>
          </>
        ) : null}

        {stage === 'sending' ? (
          <div className="ov-control-box" aria-live="polite">
            <span>{sending?.commandId ? withSlots(t('control.sending'), { topic: ackTopic, id: sending.commandId }) : t('control.posting')}</span>
            {sending?.status ? <span className="ov-mono ov-control-state">{sending.status.state}</span> : null}
          </div>
        ) : null}

        {stage === 'done' && done ? (
          <>
            <div className={`ov-control-result tone-${done.view?.tone ?? 'err'}`} aria-live="polite">
              <span className="ov-control-result-title">
                {done.view ? t(done.view.title.key, done.view.title.vars) : t('control.errorTitle', { code: done.error?.code ?? '—' })}
              </span>
              <span>{done.view ? t(done.view.body.key, done.view.body.vars) : done.error ? noticeText(t, done.error.message) : ''}</span>
              {done.restarted ? <span className="ov-control-small">{t('control.result.restarted')}</span> : null}
              {done.commandId ? <span className="ov-mono ov-control-small">{done.commandId}</span> : null}
            </div>
            <div className="ov-control-actions">
              <button className="ov-button is-wide" type="button" onClick={onDone}>{t('control.done')}</button>
              {done.view?.reload && done.view.tone !== 'ok' ? <button className="ov-button" type="button" onClick={onReload}>{t('control.reload')}</button> : null}
            </div>
          </>
        ) : null}
      </>
    );
  }

  return (
    <section id="panel-control" className="ov-control ov-card" aria-labelledby="ov-control-title">
      <div className="ov-card-head ov-card-head-rule">
        <h2 id="ov-control-title">{t('control.title')}</h2>
        <span className={`ov-chip ${unlocked ? 'tone-warn' : 'tone-neutral'}`}>{unlocked ? 'ADMIN' : 'LOCKED'}</span>
        {unlocked ? <button className="ov-icon-button" type="button" aria-label={t('control.lock')} title={t('control.lock')} onClick={onLock}><Icon name="lock" /></button> : null}
        <button className="ov-icon-button" type="button" aria-label={t('control.close')} title={t('control.close')} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="ov-control-body">{body}</div>
    </section>
  );
}

/**
 * Kontrol: an admin-gated, explicitly confirmed sdr/v1 cmd/config/patch to
 * the Raspberry. Locked until admin unlock; then edit -> review -> sending
 * -> done. Nothing is published without the review step and the explicit
 * "Kirim ke RDF-SDR" press; the server checks Origin, admin, ranges and
 * the base revision again, and reports the edge agent's ACK by command id.
 */
export function ControlPanel({ capabilities, controlDraftRequest, onClose }: ControlPanelProps): JSX.Element {
  const { t } = useI18n();
  const [admin, setAdmin] = useState<ControlAdminState>('checking');
  const [adminNotice, setAdminNotice] = useState<Notice | null>(null);
  const [reported, setReported] = useState<ConfigReported | null>(null);
  const [reportedError, setReportedError] = useState<Notice | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // Only the fields the operator edited; the others follow the reported values.
  const [draft, setDraft] = useState<DraftValues>({});
  const [stage, setStage] = useState<ControlStage>('edit');
  const [review, setReview] = useState<ControlReview | null>(null);
  const [sending, setSending] = useState<ControlSending | null>(null);
  const [done, setDone] = useState<ControlDone | null>(null);
  const [editError, setEditError] = useState<ControlFailure | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ConfigPatchChanges | null>(null);
  const mountedRef = useRef(true);
  const sendController = useRef<AbortController | null>(null);

  const ranges = capabilities?.configPatch?.ranges ?? null;
  const ttlS = Math.round((capabilities?.configPatch?.ttlMs ?? DEFAULT_TTL_MS) / 1000);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendController.current?.abort();
    };
  }, []);

  // Admin session: the HttpOnly cookie is shared with the Configuration page.
  useEffect(() => {
    const controller = new AbortController();
    getAdminStatus(controller.signal).then((result) => {
      if (!controller.signal.aborted) setAdmin(result.authenticated ? 'unlocked' : 'locked');
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return;
      setAdmin('locked');
      setAdminNotice(errorNotice(error, 'config.adminUnavailable'));
    });
    return () => controller.abort();
  }, []);

  // A new request from the spectrum dock waits here until it can be merged.
  useEffect(() => {
    if (!controlDraftRequest || controlDraftRequest.seq <= lastConsumedDraftSeq) return;
    lastConsumedDraftSeq = controlDraftRequest.seq;
    setPendingDraft(controlDraftRequest.changes);
  }, [controlDraftRequest]);

  // Reported values and the base revision, every 2 s while unlocked.
  useEffect(() => {
    if (admin !== 'unlocked') return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const poll = () => {
      controller = new AbortController();
      const signal = controller.signal;
      getConfigReported(signal).then((next) => {
        if (stopped) return;
        setReported(next);
        setReportedError(null);
      }).catch((error: unknown) => {
        if (stopped || signal.aborted || isAbort(error)) return;
        setReportedError(errorNotice(error, 'common.requestFailed'));
      }).finally(() => {
        if (!stopped) timer = setTimeout(poll, REPORTED_POLL_MS);
      });
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [admin, reloadTick]);

  // After a reload of the console, pick up a command it published that is still open.
  useEffect(() => {
    if (admin !== 'unlocked') return undefined;
    const controller = new AbortController();
    getConfigPatchStatus(undefined, controller.signal).then((latest) => {
      if (controller.signal.aborted || !latest || latest.final) return;
      setSending((current) => current ?? { commandId: latest.commandId, count: Object.keys(latest.changes).length, baseRev: latest.baseConfigRev, status: latest });
      setStage((current) => (current === 'edit' || current === 'review' ? 'sending' : current));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [admin]);

  const finish = useCallback((status: ConfigCommandStatus, count: number, baseRev: number | null) => {
    const view = commandResultView(status, count, baseRev, ttlS);
    setDone({ view, error: null, commandId: status.commandId, restarted: status.monitorRestarted });
    setStage('done');
    if (view.reload) setReloadTick((tick) => tick + 1);
  }, [ttlS]);

  // Command status, every second until it is final.
  const sendingId = stage === 'sending' ? sending?.commandId ?? null : null;
  const sendingCount = sending?.count ?? 0;
  const sendingRev = sending?.baseRev ?? null;
  useEffect(() => {
    if (!sendingId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const poll = () => {
      controller = new AbortController();
      const signal = controller.signal;
      getConfigPatchStatus(sendingId, signal).then((status) => {
        if (stopped || !status) return;
        if (status.final) {
          finish(status, sendingCount, sendingRev);
          return;
        }
        setSending((current) => (current && current.commandId === sendingId ? { ...current, status } : current));
        timer = setTimeout(poll, STATUS_POLL_MS);
      }).catch((error: unknown) => {
        if (stopped || signal.aborted || isAbort(error)) return;
        if (error instanceof ApiError && error.status === 404) {
          setDone({ view: null, error: controlFailure(error), commandId: sendingId, restarted: false });
          setStage('done');
          return;
        }
        // A failed status read leaves the command as it was; read again.
        timer = setTimeout(poll, STATUS_POLL_MS);
      });
    };
    timer = setTimeout(poll, STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [sendingId, sendingCount, sendingRev, finish]);

  const values = reported?.values ?? null;
  const evaluation = useMemo(
    () => parseDraft(CONFIG_PATCH_FIELDS, { ...(values ? draftFromReported(values) : {}), ...draft }, values ?? {}, ranges),
    [draft, values, ranges],
  );

  const enterReview = useCallback((changes: ConfigPatchChanges, rev: number | null, fields: readonly FieldEvaluation[]) => {
    setReview({ changes, rev, rows: reviewRows(t, fields) });
    setEditError(null);
    setStage('review');
  }, [t]);

  // Merge a waiting dock request once Kontrol is unlocked and has the reported values.
  useEffect(() => {
    if (!pendingDraft || admin !== 'unlocked' || !reported || stage === 'sending' || stage === 'done') return;
    const merged = { ...draft, ...mergeIntoDraft({}, pendingDraft) };
    setPendingDraft(null);
    setDraft(merged);
    const next = parseDraft(CONFIG_PATCH_FIELDS, { ...draftFromReported(reported.values), ...merged }, reported.values, ranges);
    const publishable = reported.available && capabilities?.configPatch?.enabled !== false;
    if (!next.invalid && Object.keys(next.changes).length && publishable) enterReview(next.changes, reported.baseConfigRev, next.fields);
    else setStage('edit');
  }, [pendingDraft, admin, reported, stage, draft, ranges, enterReview, capabilities]);

  const lock = () => {
    sendController.current?.abort();
    setStage('edit');
    setReview(null);
    setSending(null);
    setDone(null);
    logoutAdmin().catch(() => undefined).finally(() => {
      if (mountedRef.current) setAdmin('locked');
    });
  };

  const send = () => {
    const connected = reported?.broker.connection === 'connected';
    if (!review || review.rev === null || !connected) return;
    const reviewed = review;
    sendController.current?.abort();
    const controller = new AbortController();
    sendController.current = controller;
    const count = reviewed.rows.length;
    setSending({ commandId: null, count, baseRev: reviewed.rev, status: null });
    setStage('sending');
    sendConfigPatch({ changes: reviewed.changes, base_config_rev: reviewed.rev as number, confirm: true }, controller.signal).then((accepted) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      setSending({ commandId: accepted.commandId, count, baseRev: accepted.baseConfigRev ?? reviewed.rev, status: null });
    }).catch((error: unknown) => {
      if (!mountedRef.current || controller.signal.aborted || isAbort(error)) return;
      const failure = controlFailure(error);
      setSending(null);
      if (error instanceof ApiError && error.status === 401) {
        setAdmin('locked');
        setAdminNotice({ key: 'control.error.ADMIN_REQUIRED' });
        setStage('edit');
        return;
      }
      if (failure.code === 'CONFIG_REVISION_STALE' || failure.code === 'CONFIG_REVISION_UNKNOWN') {
        // The draft stays; the values and base revision are read again before a new review.
        setReloadTick((tick) => tick + 1);
        setEditError(failure);
        setStage('edit');
        return;
      }
      const other = error instanceof ApiError ? error.details.command_id : null;
      setDone({ view: null, error: failure, commandId: typeof other === 'string' && COMMAND_ID_RE.test(other) ? other : null, restarted: false });
      setStage('done');
    }).finally(() => {
      if (sendController.current === controller) sendController.current = null;
    });
  };

  return (
    <ControlPanelView
      capabilities={capabilities}
      admin={admin}
      adminNotice={adminNotice}
      reported={reported}
      reportedError={reportedError}
      evaluation={evaluation}
      stage={stage}
      review={review}
      sending={sending}
      done={done}
      editError={editError}
      onClose={onClose}
      onLock={lock}
      onUnlocked={() => { setAdminNotice(null); setAdmin('unlocked'); }}
      onDraftChange={(key, text) => setDraft((current) => ({ ...current, [key]: text }))}
      onReview={() => { if (!evaluation.invalid && Object.keys(evaluation.changes).length) enterReview(evaluation.changes, reported?.baseConfigRev ?? null, evaluation.fields); }}
      onReset={() => { setDraft({}); setEditError(null); }}
      onSend={send}
      onBack={() => setStage('edit')}
      onDone={() => {
        // After a result the form starts again from the reported values.
        setDone(null);
        setDraft({});
        setStage('edit');
      }}
      onReload={() => {
        setDone(null);
        setReloadTick((tick) => tick + 1);
        setStage('edit');
      }}
    />
  );
}
