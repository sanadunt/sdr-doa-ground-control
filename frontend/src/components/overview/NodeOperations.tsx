import type { JSX } from 'react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { getOperationStatus, sendNodeOperation } from '../../api';
import type { ConfigReported } from '../../api';
import { commandFailure } from '../../lib/configPatch';
import { noticeText } from '../../lib/errorNotice';
import { useI18n } from '../../lib/i18n';
import type { MessageKey, Translate } from '../../lib/i18n';
import {
  OPS_CLOSED, availableActions, canConfirm, executeRequest, firstRequest, isHostAction, operationResultView, opsStep, redundantAction,
} from '../../lib/nodeOperations';
import type { NodeAction, OpsEvent, OpsStep } from '../../lib/nodeOperations';
import { Icon } from '../ui';
import type { IconName } from '../ui';

const STATUS_POLL_MS = 1_000;
const COUNTDOWN_MS = 250;

const ICONS: Record<NodeAction, IconName> = { start: 'play', stop: 'stop', restart: 'restart', reboot: 'restart', shutdown: 'power' };

/** Why the buttons cannot send now, or null. */
function blockedKey(reported: ConfigReported | null, busy: boolean): MessageKey | null {
  if (busy) return 'ops.blockedPatch';
  if (reported?.broker.connection !== 'connected') return 'control.sendBlockedBroker';
  if (!reported.node) return 'control.sendBlockedNode';
  if (!reported.node.healthFresh) return 'control.sendBlockedHealth';
  return null;
}

export interface NodeOperationsViewProps {
  reported: ConfigReported | null;
  step: OpsStep;
  /** Kontrol is still sending a config patch: one command at a time. */
  busy?: boolean;
  /** Seconds left to confirm a prepared reboot or shutdown (stage ready). */
  secondsLeft?: number | null;
  onOpen: (action: NodeAction) => void;
  onDrone: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The operations' markup for one step; NodeOperations owns the step and the requests. */
export function NodeOperationsView({ reported, step, busy = false, secondsLeft = null, onOpen, onDrone, onConfirm, onCancel }: NodeOperationsViewProps): JSX.Element | null {
  const { t } = useI18n();
  const node = reported?.node ?? null;
  const actions = availableActions(node);
  if (actions.length === 0 && step.stage === 'closed') return null;
  const blocked = blockedKey(reported, busy);
  const run = node?.run ?? null;
  const open = step.stage !== 'closed';

  return (
    <div className="ov-control-ops" role="group" aria-labelledby="ov-control-ops-title">
      <div className="ov-control-ops-head">
        <strong id="ov-control-ops-title">{t('ops.title')}</strong>
        {run ? <span className="ov-control-small">{t('ops.processing')} <span className="ov-mono">{run}</span></span> : null}
      </div>
      <div className="ov-control-ops-buttons">
        {actions.map((action) => (
          <button
            key={action}
            className={`ov-button${isHostAction(action) ? ' is-host' : ''}`}
            type="button"
            disabled={open || blocked !== null || redundantAction(action, run)}
            aria-haspopup="dialog"
            aria-expanded={open && step.action === action}
            onClick={() => onOpen(action)}
          >
            <Icon name={ICONS[action]} /><span>{t(`ops.action.${action}`)}</span>
          </button>
        ))}
      </div>
      {blocked && !open ? <p className="ov-control-small">{t(blocked)}</p> : null}
      {open ? <OpsBox step={step} t={t} blocked={blocked} secondsLeft={secondsLeft} onDrone={onDrone} onConfirm={onConfirm} onCancel={onCancel} /> : null}
    </div>
  );
}

function OpsBox({ step, t, blocked, secondsLeft, onDrone, onConfirm, onCancel }: {
  step: Exclude<OpsStep, { stage: 'closed' }>;
  t: Translate;
  blocked: MessageKey | null;
  secondsLeft: number | null;
  onDrone: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const action = step.action;
  const host = isHostAction(action);
  const asking = step.stage === 'confirm' || step.stage === 'ready';
  const view = step.stage === 'done' && step.status ? operationResultView(action, step.status) : null;
  const confirmLabel: MessageKey = step.stage === 'ready'
    ? (action === 'shutdown' ? 'ops.execute.shutdown' : 'ops.execute.reboot')
    : host ? (action === 'shutdown' ? 'ops.prepare.shutdown' : 'ops.prepare.reboot') : `ops.action.${action}`;
  return (
    <div
      className={`ov-control-box ov-control-ops-box${host ? ' is-host' : ''}`}
      role="alertdialog"
      aria-labelledby="ov-control-ops-question"
      aria-describedby={asking ? 'ov-control-ops-effect' : undefined}
    >
      <strong id="ov-control-ops-question">{t(`ops.confirm.${action}`)}</strong>
      {step.stage === 'confirm' ? <span id="ov-control-ops-effect">{t(`ops.effect.${action}`)}</span> : null}
      {step.stage === 'confirm' && host ? (
        <div className="ov-control-warn ov-control-confirm" role="note">
          <span>{t('ops.droneWarn')}</span>
          <label>
            <input type="checkbox" checked={step.droneChecked} onChange={(event) => onDrone(event.target.checked)} />
            <span>{t('ops.droneConfirm')}</span>
          </label>
        </div>
      ) : null}
      {step.stage === 'ready' ? (
        <span id="ov-control-ops-effect" className="ov-control-warn" role="status">
          {t(action === 'shutdown' ? 'ops.ready.shutdown' : 'ops.ready.reboot', { seconds: secondsLeft ?? 0 })}
        </span>
      ) : null}
      {step.stage === 'sending' ? (
        <span role="status">
          {t(step.phase === 'prepare' ? 'ops.preparing' : 'ops.waiting')}
          {step.status ? <> · <span className="ov-mono">{step.status.ack?.status ?? step.status.state}</span></> : null}
        </span>
      ) : null}
      {step.stage === 'done' && step.expired ? <span role="status">{t('ops.prepareExpired')}</span> : null}
      {step.stage === 'done' && step.failure ? (
        <span className="ov-control-error" role="alert"><span className="ov-mono">{step.failure.code}</span> · {noticeText(t, step.failure.message)}</span>
      ) : null}
      {view ? (
        <div className={`ov-control-result tone-${view.tone}`} aria-live="polite">
          <span className="ov-control-result-title">{t(view.title.key, view.title.vars)}</span>
          <span>{t(view.body.key, view.body.vars)}</span>
          {view.message ? <span>{t('control.result.edgeMessage', { message: view.message })}</span> : null}
          {view.code ? <span className="ov-mono ov-control-small">{t('control.result.code', { code: view.code })}</span> : null}
        </div>
      ) : null}
      {asking && blocked ? <span className="ov-control-small">{t(blocked)}</span> : null}
      <div className="ov-control-actions">
        {/* A new element per step, so autoFocus moves the focus to Cancel each time. */}
        <button key={step.stage} className="ov-button" type="button" autoFocus disabled={step.stage === 'sending'} onClick={onCancel}>
          {asking ? t('ops.cancel') : t('ops.close')}
        </button>
        {asking ? (
          <button
            className={`ov-button is-wide${host ? ' is-danger' : ' is-primary'}`}
            type="button"
            disabled={!canConfirm(step) || blocked !== null}
            onClick={onConfirm}
          >
            <Icon name={ICONS[action]} /><span>{t(confirmLabel)}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Start or stop the RDF processing, restart the RDF service, and reboot or
 * shut down the Raspberry, inside Kontrol (admin unlocked). Each command is
 * sent once, after the confirm box; its status is read every second until it
 * is final. A reboot or shutdown is prepared first and executed only on a
 * second click while the RDF-SDR's challenge lasts.
 */
export function NodeOperations({ reported, busy = false }: { reported: ConfigReported | null; busy?: boolean }): JSX.Element | null {
  const [step, dispatch] = useReducer(opsStep, OPS_CLOSED);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestRef = useRef<AbortController | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => () => requestRef.current?.abort(), []);

  const send = useCallback((request: Parameters<typeof sendNodeOperation>[0]) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    sendNodeOperation(request, controller.signal).then(
      (accepted) => dispatch({ type: 'posted', commandId: accepted.commandId }),
      (error: unknown) => { if (!controller.signal.aborted) dispatch({ type: 'failed', failure: commandFailure(error) }); },
    );
  }, []);

  const confirm = () => {
    const current = stepRef.current;
    if (!canConfirm(current) || blockedKey(reported, busy) !== null) return;
    if (current.stage === 'confirm') {
      dispatch({ type: 'post' });
      send(firstRequest(current.action));
    } else if (current.stage === 'ready') {
      dispatch({ type: 'post' });
      send(executeRequest(current.action, current.prepareId));
    }
  };

  const cancel = useCallback(() => dispatch({ type: 'cancel' }), []);

  // Follow the posted command until it is final; nothing is sent again.
  const commandId = step.stage === 'sending' ? step.commandId : null;
  useEffect(() => {
    if (!commandId) return undefined;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = () => {
      getOperationStatus(commandId, controller.signal).then(
        (status) => {
          if (!status) return;
          const event: OpsEvent = { type: 'status', status, localNowMs: Date.now() };
          dispatch(event);
          if (!status.final) timer = window.setTimeout(poll, STATUS_POLL_MS);
        },
        () => { if (!controller.signal.aborted) timer = window.setTimeout(poll, STATUS_POLL_MS); },
      );
    };
    timer = window.setTimeout(poll, STATUS_POLL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [commandId]);

  // The second confirmation lasts only as long as the RDF-SDR's challenge.
  const validUntil = step.stage === 'ready' ? step.validUntilMs : null;
  useEffect(() => {
    if (validUntil === null) return undefined;
    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      if (now >= validUntil) dispatch({ type: 'expired' });
    };
    tick();
    const timer = window.setInterval(tick, COUNTDOWN_MS);
    return () => window.clearInterval(timer);
  }, [validUntil]);

  // Escape cancels the confirm box and a ready prepare, never a command on its way.
  const cancellable = step.stage === 'confirm' || step.stage === 'ready';
  useEffect(() => {
    if (!cancellable) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancellable, cancel]);

  return (
    <NodeOperationsView
      reported={reported}
      step={step}
      busy={busy}
      secondsLeft={validUntil === null ? null : Math.max(0, Math.ceil((validUntil - nowMs) / 1000))}
      onOpen={(action) => dispatch({ type: 'open', action })}
      onDrone={(checked) => dispatch({ type: 'drone', checked })}
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}
