import type { CSSProperties, JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TelemetrySnapshot } from '../types';
import { deliveryCheckKey, deliveryStateKey, deliveryView } from '../lib/delivery';
import type { DeliveryCheck } from '../lib/delivery';
import { gateReasonLabel, useI18n } from '../lib/i18n';

const PANEL_GAP_PX = 6;
const PANEL_MARGIN_PX = 8;
const PANEL_WIDTH_PX = 340;

function checkMark(check: DeliveryCheck): string {
  return check.ok === true ? '✓' : check.ok === false ? '✗' : '–';
}

/**
 * The Delivery (Publikasi) chip of the status strip. It names whether the
 * publication gate waits only on setup or the data has a problem, and opens
 * a checklist of the gate's reasons and checks. The open panel is portalled
 * to the body and fixed to the viewport: the strip's horizontal scroll never
 * clips it, and the strip's grid keeps exactly one child per chip.
 */
export function DeliveryChecklist({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { lang, t } = useI18n();
  const view = deliveryView(snapshot);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const toggle = () => {
    if (open) { close(false); return; }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(PANEL_WIDTH_PX, window.innerWidth - PANEL_MARGIN_PX * 2);
      const left = Math.max(PANEL_MARGIN_PX, Math.min(rect.left, window.innerWidth - width - PANEL_MARGIN_PX));
      setPosition({ top: rect.bottom + PANEL_GAP_PX, left, width });
    }
    setOpen(true);
    window.requestAnimationFrame(() => panelRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(true); };
    // The panel is placed from the button once; a resize would move the button away from it.
    const onResize = () => setOpen(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const reasonList = (reasons: string[]) => (
    <ul className="delivery-reasons">
      {reasons.map((reason) => <li key={reason}><span>{gateReasonLabel(lang, reason)}</span><code>{reason}</code></li>)}
    </ul>
  );
  const checkList = (group: DeliveryCheck['group']) => {
    const checks = view.checks.filter((check) => check.group === group);
    if (checks.length === 0) return null;
    return (
      <>
        <h5>{t(group === 'data' ? 'delivery.groupData' : 'delivery.groupSetup')}</h5>
        <ul className="delivery-checks">
          {checks.map((check) => {
            const key = deliveryCheckKey(check.key);
            const state = check.ok === true ? 'delivery.checkPass' : check.ok === false ? 'delivery.checkFail' : 'delivery.checkUnknown';
            return (
              <li key={check.key} className={check.ok === true ? 'is-pass' : check.ok === false ? 'is-fail' : 'is-unknown'}>
                <span className="delivery-mark" aria-hidden="true">{checkMark(check)}</span>
                <span>{key ? t(key) : check.key}</span>
                <span className="visually-hidden">{t(state)}</span>
              </li>
            );
          })}
        </ul>
      </>
    );
  };

  return (
    <>
      <button
        ref={buttonRef}
        className={`telemetry-item telemetry-button tone-${view.tone}`}
        type="button"
        aria-expanded={open}
        aria-controls="delivery-checklist"
        aria-label={`${t('status.delivery')}: ${t(deliveryStateKey(view.state))} · ${t('delivery.open')}`}
        onClick={toggle}
      >
        <span className="telemetry-key">{t('status.delivery')}</span>
        <span className="telemetry-value"><i aria-hidden="true" />{t(deliveryStateKey(view.state))}</span>
      </button>
      {open && typeof document !== 'undefined' ? createPortal(<>
      <div className="delivery-backdrop" aria-hidden="true" onClick={() => close(false)} />
      <div
        id="delivery-checklist"
        ref={panelRef}
        className="delivery-panel"
        role="dialog"
        aria-label={t('delivery.open')}
        tabIndex={-1}
        style={position}
      >
        <div className="delivery-head">
          <h3>{t('status.delivery')} <span className={`tone-${view.tone}`}>{t(deliveryStateKey(view.state))}</span></h3>
          <button className="ov-icon-button" type="button" aria-label={t('delivery.close')} onClick={() => close(true)}>×</button>
        </div>
        {view.problems.length > 0 ? <section><h4 className="is-warn">{t('delivery.problems')}</h4>{reasonList(view.problems)}</section> : null}
        {view.setup.length > 0 ? <section><h4>{t('delivery.setupTitle')}</h4>{reasonList(view.setup)}</section> : null}
        {view.notes.length > 0 ? <section><h4>{t('delivery.notes')}</h4>{reasonList(view.notes)}</section> : null}
        {view.checks.length > 0 ? <section><h4>{t('delivery.checks')}</h4>{checkList('data')}{checkList('setup')}</section> : null}
      </div>
      </>, document.body) : null}
    </>
  );
}
