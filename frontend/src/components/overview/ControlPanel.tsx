import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getAdminStatus, getConfigPatchStatus, getConfigReported, logoutAdmin, requestConfigGet, sendConfigPatch } from '../../api';
import type { ConfigCommandStatus, ConfigReported, ConsoleCapabilities } from '../../api';
import type { ConfigPatchChanges, ConfigPatchKey, ControlDraftRequest } from '../../lib/controlDraft';
import {
  CONFIG_PATCH_ERROR_KEYS,
  CONFIG_PATCH_FIELDS,
  GAIN_TABLE_DB,
  commandResultView,
  displayValue,
  draftFromReported,
  draftWithCenter,
  fieldFor,
  isConfigPatchErrorCode,
  mergeIntoDraft,
  parseDraft,
  plainNumber,
  rangeParts,
  settingsReadView,
} from '../../lib/configPatch';
import type { CommandResultView, ConfigPatchRanges, DraftEvaluation, DraftValues, FieldEvaluation } from '../../lib/configPatch';
import { VERIFY_WINDOW_MS, currentConfigValues, dataOutConfigValues, verifyConfigPatch } from '../../lib/configVerify';
import type { ConfigVerification, VerifyStatus, VerifyVerdict } from '../../lib/configVerify';
import type { TelemetrySnapshot } from '../../types';
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
  /** Latest Data Out snapshot: current values settings/reported lacks, and the read-back check. */
  snapshot?: TelemetrySnapshot | null;
  localSnapshotFresh?: boolean;
  /** Read Data Out now, settings.json included (App's refresh; must be stable). */
  onRefreshSnapshot?: () => void;
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
  /** A published command to read back from the RDF-SDR. */
  verify?: ControlVerifyTarget;
}
/** What was sent, when it was issued (server clock) and when it became final (browser clock). */
export interface ControlVerifyTarget { changes: ConfigPatchChanges; issuedAtMs: number | null; finalAtMs: number; windowMs?: number }

/** Topic suffixes shown before the server reports the full topics. */
const PATCH_TOPIC_SUFFIX = 'cmd/config/patch';
const ACK_TOPIC_SUFFIX = 'ack/config';
const REPORTED_POLL_MS = 2_000;
const STATUS_POLL_MS = 1_000;
const DEFAULT_TTL_MS = 15_000;
const COMMAND_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/u;
/** Refusals of a command that was not sent; the draft stays and the values are read again. */
const RETRY_IN_FORM_CODES = new Set(['CONFIG_REVISION_STALE', 'CONFIG_REVISION_UNKNOWN', 'NODE_NOT_FRESH', 'NODE_SESSION_UNAVAILABLE']);

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
  if (evaluation.problem === 'table') return { text: t('control.notInGainTable'), tone: 'error' };
  if (evaluation.problem === 'centerVfo') return { text: t('control.vfoMustFollowCenter'), tone: 'error' };
  if (evaluation.required) return { text: t('control.vfoFollowsCenter'), tone: 'changed' };
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

/** Select options for a table field: every table value, and the current text when it is none of them. */
function tableOptions(entry: FieldEvaluation, table: readonly number[]): Array<{ value: string; label: string }> {
  const options = table.map((gain) => ({ value: plainNumber(gain), label: displayValue(entry.field, gain) }));
  if (entry.text.trim() !== '' && !options.some((option) => option.value === entry.text)) {
    options.unshift({ value: entry.text, label: entry.value === null ? entry.text : displayValue(entry.field, entry.value) });
  }
  return options;
}

const VERIFY_CHIPS: Record<VerifyStatus, { code: string; tone: string }> = {
  confirmed: { code: 'CONFIRMED', tone: 'good' },
  pending: { code: 'PENDING', tone: 'info' },
  unchanged: { code: 'UNCHANGED', tone: 'warn' },
  'not-reported': { code: 'NOT REPORTED', tone: 'neutral' },
};

const VERIFY_VERDICTS: Record<VerifyVerdict, { key: MessageKey; tone: string }> = {
  confirmed: { key: 'verify.verdict.confirmed', tone: 'good' },
  partial: { key: 'verify.verdict.partial', tone: 'warn' },
  pending: { key: 'verify.verdict.pending', tone: 'info' },
  unchanged: { key: 'verify.verdict.unchanged', tone: 'warn' },
  'not-reported': { key: 'verify.verdict.notReported', tone: 'neutral' },
};

/** Read-back after a final command: sent value, settings/reported (MQTT), Data Out and a status per field. */
export function VerifyList({ verification, onRecheck }: { verification: ConfigVerification; onRecheck?: () => void }): JSX.Element {
  const { t } = useI18n();
  const verdict = VERIFY_VERDICTS[verification.verdict];
  return (
    <section className="ov-verify" aria-label={t('verify.title')}>
      <div className="ov-verify-head">
        <span className={`ov-verify-verdict tone-${verdict.tone}`} role="status">{t(verdict.key, { confirmed: verification.confirmed, total: verification.total })}</span>
        {onRecheck ? <button className="ov-button" type="button" onClick={onRecheck}><Icon name="refresh" /><span>{t('verify.recheck')}</span></button> : null}
      </div>
      <ul className="ov-verify-list">
        {verification.fields.map((row) => {
          const field = fieldFor(row.key);
          const chip = VERIFY_CHIPS[row.status];
          return (
            <li key={row.key}>
              <div className="ov-verify-row"><span>{t(field.shortLabel)}</span><span className={`ov-tag tone-${chip.tone}`}>{chip.code}</span></div>
              <dl className="ov-verify-values">
                <div><dt>{t('verify.sent')}</dt><dd className="ov-mono">{displayValue(field, row.sent)}</dd></div>
                <div><dt>{t('verify.mqtt')}</dt><dd className="ov-mono">{displayValue(field, row.mqtt)}</dd></div>
                <div><dt>{t('verify.dataOut')}</dt><dd className="ov-mono">{displayValue(field, row.dataOut)}</dd></div>
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Where the form's current values come from. */
export type ControlValueSource = 'settings' | 'data-out' | 'none';

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
  /** Read-back of the final command, when it was published. */
  verification?: ConfigVerification | null;
  /** Where the current values come from (settings/reported, Data Out or neither). */
  valueSource?: ControlValueSource;
  /** A config.get the console refused, by its code. */
  settingsError?: ControlFailure | null;
  onRecheck?: () => void;
  onReadSettings?: () => void;
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
  verification = null,
  valueSource = 'none',
  settingsError = null,
  onRecheck,
  onReadSettings,
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
  const gainTable = patch?.gainTableDb.length ? patch.gainTableDb : GAIN_TABLE_DB;
  const topic = patch?.topic ?? PATCH_TOPIC_SUFFIX;
  const ackTopic = patch?.ackTopic ?? ACK_TOPIC_SUFFIX;
  const ttlS = Math.round((patch?.ttlMs ?? DEFAULT_TTL_MS) / 1000);
  const qos = patch?.qos ?? 1;
  const unlocked = admin === 'unlocked';
  const defaultPassword = capabilities?.adminDefaultPassword === true;
  const changeCount = Object.keys(evaluation.changes).length;
  const patchUnavailable = patch?.enabled === false || (reported !== null && !reported.available);
  const connected = reported?.broker.connection === 'connected';
  const node = reported?.node ?? null;
  const baseRev = reported?.baseRev ?? null;
  const brokerText = reported?.broker.host ? `${reported.broker.host}${reported.broker.port ? `:${reported.broker.port}` : ''}` : '—';
  const settings = reported?.settings ?? null;
  const settingsRead = settingsReadView(reported?.settingsRequest);
  const reading = settingsRead?.key === 'control.settings.reading';
  const reviewBlocked: MessageKey | null = !review ? null
    : patchUnavailable ? 'control.patchUnavailable'
      : !connected ? 'control.sendBlockedBroker'
        : !node ? 'control.sendBlockedNode'
          : review.rev === null ? 'control.sendBlockedRev'
            : !node.healthFresh ? 'control.sendBlockedHealth' : null;

  let settingsLine: ReactNode;
  if (!settings) settingsLine = t('control.settingsNone');
  else if (settings.matchesStateCfg) {
    settingsLine = withSlots(t('control.settingsReported'), {
      rev: settings.rev ?? '—',
      age: settings.ageMs === null ? '—' : t('common.durationS', { value: Number((settings.ageMs / 1000).toFixed(1)) }),
    });
  } else {
    settingsLine = withSlots(t('control.settingsOld'), { rev: settings.rev ?? '—', cfg: baseRev ?? t('control.revUnknown') });
  }

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
            {node
              ? withSlots(t('control.node'), { sid: node.sid, health: node.healthFresh ? 'FRESH' : 'STALE' })
              : t('control.nodeNone')}
          </span>
          <span className="ov-control-settings">
            <span>{settingsLine}</span>
            {onReadSettings ? (
              <button className="ov-button" type="button" disabled={!connected || !node || reading || patchUnavailable} onClick={onReadSettings}>
                {t('control.readSettings')}
              </button>
            ) : null}
          </span>
          <span>{t(valueSource === 'settings' ? 'control.valuesSettings' : valueSource === 'data-out' ? 'control.valuesDataOut' : 'control.valuesNone')}</span>
        </div>
        {settingsRead ? (
          <p className={settingsRead.tone === 'info' ? 'ov-control-note' : settingsRead.tone === 'warn' ? 'ov-control-warn' : 'ov-control-error'} role="status">
            {settingsRead.code ? <><span className="ov-mono">{settingsRead.code}</span> · </> : null}{t(settingsRead.key)}
          </p>
        ) : null}
        {settingsError ? (
          <p className="ov-control-error" role="alert"><span className="ov-mono">{settingsError.code}</span> · {noticeText(t, settingsError.message)}</p>
        ) : null}
        {node?.remoteConfigPatch === false ? <p className="ov-control-warn">{t('control.noSettingsTarget')}</p> : null}
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
                      {entry.field.table ? (
                        <select
                          id={inputId}
                          value={entry.text}
                          disabled={!reported}
                          aria-invalid={hint?.tone === 'error' ? true : undefined}
                          aria-describedby={hintId}
                          onChange={(event) => onDraftChange(entry.field.key, event.target.value)}
                        >
                          {entry.text.trim() === '' ? <option value="">—</option> : null}
                          {tableOptions(entry, gainTable).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      ) : (
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
                      )}
                      {entry.field.table ? null : <span>{entry.field.unit}</span>}
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
            {sending?.status ? <span className="ov-mono ov-control-state">{sending.status.ack?.status ?? sending.status.state}</span> : null}
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
            {verification ? <VerifyList verification={verification} onRecheck={onRecheck} /> : null}
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

/** Where the values the form starts from come from. */
export function controlValueSource(reported: ConfigReported | null, dataOut: Record<ConfigPatchKey, number | null>): ControlValueSource {
  if (reported && Object.values(reported.valueSources).some((source) => source !== null)) return 'settings';
  if (Object.values(dataOut).some((value) => value !== null)) return 'data-out';
  return 'none';
}

/**
 * Kontrol: an admin-gated, explicitly confirmed config.patch to the RDF-SDR
 * in the edge's own format. Locked until admin unlock; then edit -> review
 * -> sending -> done. Nothing is published without the review step and the
 * explicit "Kirim ke RDF-SDR" press; the server checks Origin, admin, the
 * edge's field rules, the node session, fresh health and the base revision
 * again, and reports the edge's ACKs by command id. The current values come
 * from settings/reported (after a config.get), else from fresh Data Out.
 */
export function ControlPanel({ capabilities, controlDraftRequest, onClose, snapshot = null, localSnapshotFresh = false, onRefreshSnapshot }: ControlPanelProps): JSX.Element {
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
  const [settingsError, setSettingsError] = useState<ControlFailure | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ConfigPatchChanges | null>(null);
  const [, setVerifyTick] = useState(0);
  const mountedRef = useRef(true);
  const sendController = useRef<AbortController | null>(null);
  const settingsController = useRef<AbortController | null>(null);
  // One automatic config.get per unlock, when no settings report is current.
  const autoReadRef = useRef(false);

  const ranges = capabilities?.configPatch?.ranges ?? null;
  const gainTable = capabilities?.configPatch?.gainTableDb.length ? capabilities.configPatch.gainTableDb : GAIN_TABLE_DB;
  const ttlS = Math.round((capabilities?.configPatch?.ttlMs ?? DEFAULT_TTL_MS) / 1000);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendController.current?.abort();
      settingsController.current?.abort();
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

  // Reported values, the node session and the base revision, every 2 s while unlocked.
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
      setSending((current) => current ?? { commandId: latest.commandId, count: Object.keys(latest.changes).length, baseRev: latest.baseRev, status: latest });
      setStage((current) => (current === 'edit' || current === 'review' ? 'sending' : current));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [admin]);

  // config.get: the edge answers with settings/reported (only over a TLS link to the broker).
  const readSettings = useCallback(() => {
    settingsController.current?.abort();
    const controller = new AbortController();
    settingsController.current = controller;
    setSettingsError(null);
    requestConfigGet(controller.signal).then(() => {
      if (!mountedRef.current || controller.signal.aborted) return;
      setReloadTick((tick) => tick + 1);
    }).catch((error: unknown) => {
      if (!mountedRef.current || controller.signal.aborted || isAbort(error)) return;
      if (error instanceof ApiError && error.status === 401) {
        setAdmin('locked');
        setAdminNotice({ key: 'control.error.ADMIN_REQUIRED' });
        return;
      }
      setSettingsError(controlFailure(error));
    }).finally(() => {
      if (settingsController.current === controller) settingsController.current = null;
    });
  }, []);

  useEffect(() => {
    if (admin !== 'unlocked') autoReadRef.current = false;
  }, [admin]);

  // Read the node's settings once after unlock when no report of its current revision is here.
  useEffect(() => {
    if (admin !== 'unlocked' || autoReadRef.current || !reported?.available || !reported.node) return;
    if (reported.broker.connection !== 'connected' || reported.settings?.matchesStateCfg) return;
    if (reported.settingsRequest && !reported.settingsRequest.final) return;
    autoReadRef.current = true;
    readSettings();
  }, [admin, reported, readSettings]);

  const finish = useCallback((status: ConfigCommandStatus, count: number, baseRev: number | null) => {
    const view = commandResultView(status, count, baseRev, ttlS);
    // A publish the broker refused reached nothing; there is nothing to read back.
    // When the RDF-SDR answered that it did not apply the patch, read back once
    // without waiting for a change that will not come.
    const refused = status.ack !== null && ['REJECTED', 'CONFLICT', 'EXPIRED', 'FAILED', 'CANCELLED'].includes(status.ack.status);
    const verify = status.state !== 'publish_failed' && Object.keys(status.changes).length
      ? { changes: status.changes, issuedAtMs: status.issuedMs, finalAtMs: Date.now(), ...(refused ? { windowMs: 0 } : {}) }
      : undefined;
    setDone({ view, error: null, commandId: status.commandId, restarted: status.monitorRestarted, verify });
    setStage('done');
    if (view.reload) setReloadTick((tick) => tick + 1);
    if (verify) {
      // The new values arrive as settings/reported after a config.get, and
      // the console may reuse settings.json for a while: read both now.
      readSettings();
      onRefreshSnapshot?.();
    }
  }, [ttlS, onRefreshSnapshot, readSettings]);

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

  // settings/reported first; a fresh Data Out snapshot fills what it does not carry.
  const dataOut = useMemo(() => dataOutConfigValues(snapshot, localSnapshotFresh), [snapshot, localSnapshotFresh]);
  const values = useMemo(() => (reported ? currentConfigValues(reported.values, dataOut) : null), [reported, dataOut]);
  const valueSource = controlValueSource(reported, dataOut);
  const evaluation = useMemo(
    () => parseDraft(CONFIG_PATCH_FIELDS, { ...(values ? draftFromReported(values) : {}), ...draft }, values ?? {}, ranges, gainTable),
    [draft, values, ranges, gainTable],
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
    const current = values ?? reported.values;
    const next = parseDraft(CONFIG_PATCH_FIELDS, { ...draftFromReported(current), ...merged }, current, ranges, gainTable);
    const publishable = reported.available && capabilities?.configPatch?.enabled !== false;
    if (!next.invalid && Object.keys(next.changes).length && publishable) enterReview(next.changes, reported.baseRev, next.fields);
    else setStage('edit');
  }, [pendingDraft, admin, reported, values, stage, draft, ranges, gainTable, enterReview, capabilities]);

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
    if (!review || review.rev === null || !connected || !reported?.node?.healthFresh) return;
    const reviewed = review;
    sendController.current?.abort();
    const controller = new AbortController();
    sendController.current = controller;
    const count = reviewed.rows.length;
    setSending({ commandId: null, count, baseRev: reviewed.rev, status: null });
    setStage('sending');
    sendConfigPatch({ changes: reviewed.changes, base_rev: reviewed.rev as number, confirm: true }, controller.signal).then((accepted) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      setSending({ commandId: accepted.commandId, count, baseRev: accepted.baseRev ?? reviewed.rev, status: null });
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
      if (RETRY_IN_FORM_CODES.has(failure.code)) {
        // Nothing was sent. The draft stays; the values, the node and the base revision are read again first.
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

  // Read back what the RDF-SDR reports now; render once more when the window ends.
  const verifyTarget = stage === 'done' ? done?.verify ?? null : null;
  const verifyEndsAt = verifyTarget ? verifyTarget.finalAtMs + (verifyTarget.windowMs ?? VERIFY_WINDOW_MS) : null;
  useEffect(() => {
    if (verifyEndsAt === null) return undefined;
    const delay = verifyEndsAt - Date.now();
    if (delay < 0) return undefined;
    const timer = setTimeout(() => setVerifyTick((tick) => tick + 1), delay + 1);
    return () => clearTimeout(timer);
  }, [verifyEndsAt]);
  const verification = verifyTarget
    ? verifyConfigPatch({ ...verifyTarget, nowMs: Date.now(), reported, snapshot, snapshotFresh: localSnapshotFresh })
    : null;
  const recheck = useCallback(() => {
    onRefreshSnapshot?.();
    readSettings();
    setReloadTick((tick) => tick + 1);
  }, [onRefreshSnapshot, readSettings]);

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
      verification={verification}
      valueSource={valueSource}
      settingsError={settingsError}
      onRecheck={recheck}
      onReadSettings={readSettings}
      onClose={onClose}
      onLock={lock}
      onUnlocked={() => { setAdminNotice(null); setAdmin('unlocked'); }}
      onDraftChange={(key, text) => setDraft((current) => (
        key === 'center_frequency_hz' ? draftWithCenter(current, text, values ?? {}) : { ...current, [key]: text }
      ))}
      onReview={() => { if (!evaluation.invalid && Object.keys(evaluation.changes).length) enterReview(evaluation.changes, reported?.baseRev ?? null, evaluation.fields); }}
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
        readSettings();
        setReloadTick((tick) => tick + 1);
        setStage('edit');
      }}
    />
  );
}
