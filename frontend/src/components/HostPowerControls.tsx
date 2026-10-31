import type { CSSProperties, JSX, MouseEvent, RefObject } from 'react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../lib/i18n';
import type { Translate } from '../lib/i18n';
import {
  HOST_POWER_ACTIONS, HOST_POWER_CLOSED, HostPowerError, canSend, errorKey, hostPowerStep, readReceiverBusy, reasonKey, requestHostPower,
} from '../lib/hostPower';
import type { HostPowerAction, HostPowerCapability, HostPowerStep } from '../lib/hostPower';
import { Icon } from './ui';

const PANEL_GAP_PX = 6;
const PANEL_MARGIN_PX = 8;
const PANEL_WIDTH_PX = 360;
/** /api/health answers at once, but can queue behind the map's tile requests; past this the Receiver's state counts as unknown. */
const HEALTH_TIMEOUT_MS = 6_000;

const ICONS: Record<HostPowerAction, 'restart' | 'power'> = { reboot: 'restart', poweroff: 'power' };

/**
 * The confirm panel's content for one step. Cancel comes first and takes the
 * focus; the action button waits for the Receiver's state.
 */
export function HostPowerPanel({ step, t, onCancel, onSend }: {
  step: Exclude<HostPowerStep, { stage: 'closed' }>;
  t: Translate;
  onCancel: () => void;
  onSend: () => void;
}): JSX.Element {
  const asking = step.stage === 'confirm' || step.stage === 'sending';
  const busy = asking ? step.busy : null;
  const failure = step.stage === 'failed' ? errorKey(step.code) : null;
  return (
    <>
      <h3 id="host-power-title">{t(`power.confirm.${step.action}`)}</h3>
      {asking ? <p id="host-power-effect">{t(`power.effect.${step.action}`)}</p> : null}
      {busy === 'busy' ? <p className="host-power-warning" role="alert">{t('power.busy')}</p> : null}
      {busy === 'checking' ? <p className="host-power-note">{t('power.busyChecking')}</p> : null}
      {busy === 'unknown' ? <p className="host-power-note">{t('power.busyUnknown')}</p> : null}
      {step.stage === 'sent' ? <p className="host-power-done" role="status">{t(`power.sent.${step.action}`)}</p> : null}
      {step.stage === 'failed' ? (
        <p className="host-power-failed" role="alert">
          {t('power.failed', { error: failure ? t(failure) : step.message })}
          {step.code ? <code>{step.reason ? `${step.code} · ${step.reason}` : step.code}</code> : null}
        </p>
      ) : null}
      <div className="host-power-actions">
        {/* A new element per step, so autoFocus moves the focus to it each time. */}
        <button key={step.stage} className="ov-button" type="button" autoFocus disabled={step.stage === 'sending'} onClick={onCancel}>
          {asking ? t('power.cancel') : t('power.close')}
        </button>
        {asking ? (
          <button className="ov-button is-danger is-wide" type="button" disabled={!canSend(step)} onClick={onSend}>
            <Icon name={ICONS[step.action]} />
            <span>{step.stage === 'sending' ? t('power.sending') : t(`power.${step.action}`)}</span>
          </button>
        ) : null}
      </div>
    </>
  );
}

/** The Restart and Shutdown buttons; disabled with the reason until the host side is installed. */
export function HostPowerButtons({ capability, active, t, onOpen, groupRef }: {
  capability: HostPowerCapability | null;
  active: HostPowerAction | null;
  t: Translate;
  onOpen: (action: HostPowerAction, event: MouseEvent<HTMLButtonElement>) => void;
  groupRef?: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const available = capability?.available === true;
  const reason = t(reasonKey(capability?.reason ?? null));
  return (
    <div ref={groupRef} className="host-power" role="group" aria-label={t('power.group')}>
      {HOST_POWER_ACTIONS.map((action) => {
        const label = t(`power.${action}Label`);
        const title = available ? label : t('power.unavailable', { action: label, reason });
        return (
          <button
            key={action}
            className={`icon-button host-power-button is-${action}`}
            type="button"
            disabled={!available}
            aria-label={title}
            aria-haspopup="dialog"
            aria-expanded={active === action}
            title={title}
            onClick={(event) => onOpen(action, event)}
          >
            <Icon name={ICONS[action]} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Restart and Shutdown of the groundstation PC, in the top bar after EN|ID.
 * A click opens a confirm panel that names the action and, when /api/health
 * reports receiver_busy, warns that a Receiver recording or scan stops. Only
 * its button posts. Escape or Cancel closes it.
 */
export function HostPowerControls({ capability }: { capability: HostPowerCapability | null }): JSX.Element {
  const { t } = useI18n();
  const [step, dispatch] = useReducer(hostPowerStep, HOST_POWER_CLOSED);
  const [position, setPosition] = useState<CSSProperties>({});
  const groupRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const healthRef = useRef<AbortController | null>(null);
  const sendRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    healthRef.current?.abort();
    sendRef.current?.abort();
  }, []);

  const close = useCallback(() => {
    healthRef.current?.abort();
    healthRef.current = null;
    dispatch({ type: 'cancel' });
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }, []);

  const open = (action: HostPowerAction, event: MouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget;
    const rect = groupRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(PANEL_WIDTH_PX, window.innerWidth - PANEL_MARGIN_PX * 2);
      const left = Math.max(PANEL_MARGIN_PX, Math.min(rect.right - width, window.innerWidth - width - PANEL_MARGIN_PX));
      setPosition({ top: rect.bottom + PANEL_GAP_PX, left, width });
    }
    dispatch({ type: 'open', action });
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
    if (!canSend(step) || step.stage !== 'confirm') return;
    const action = step.action;
    dispatch({ type: 'send' });
    const controller = new AbortController();
    sendRef.current = controller;
    requestHostPower(action, controller.signal).then(
      () => dispatch({ type: 'sent' }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof HostPowerError) dispatch({ type: 'failed', code: error.code, reason: error.reason, message: error.message });
        else dispatch({ type: 'failed', code: null, message: t('power.error.network') });
      },
    );
  };

  const panelOpen = step.stage !== 'closed';
  useEffect(() => {
    if (!panelOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    // The panel is placed from the buttons once; a resize would move them away from it.
    const onResize = () => close();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [panelOpen, close]);

  return (
    <>
      <HostPowerButtons capability={capability} active={step.stage === 'closed' ? null : step.action} t={t} onOpen={open} groupRef={groupRef} />
      {step.stage !== 'closed' && typeof document !== 'undefined' ? createPortal(
        <div
          className={`host-power-panel is-${step.action}`}
          role="alertdialog"
          aria-labelledby="host-power-title"
          aria-describedby={step.stage === 'confirm' || step.stage === 'sending' ? 'host-power-effect' : undefined}
          style={position}
        >
          <HostPowerPanel step={step} t={t} onCancel={close} onSend={send} />
        </div>,
        document.body,
      ) : null}
    </>
  );
}
