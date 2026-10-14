import type { FormEvent, JSX } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { loginAdmin } from '../api';
import { adminErrorKey } from '../lib/configForm';
import { errorNotice, noticeText } from '../lib/errorNotice';
import type { Notice } from '../lib/errorNotice';
import { useI18n } from '../lib/i18n';

/**
 * Compact admin password form for Kontrol. It opens the same HttpOnly admin
 * session the Configuration page uses; the password never leaves this form
 * except in the login POST, and it is cleared after every attempt.
 */
export function AdminUnlock({
  disabled = false,
  defaultPassword = false,
  notice = null,
  onUnlocked,
}: {
  /** Admin login is disabled on the server (empty SDR_DOA_ADMIN_PASSWORD). */
  disabled?: boolean;
  /** The server uses the built-in default password. */
  defaultPassword?: boolean;
  /** A message to show before the first attempt (for example, an ended session). */
  notice?: Notice | null;
  onUnlocked: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const inputId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled || !password) return;
    const attempt = password;
    setPassword('');
    setBusy(true);
    setError(null);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    loginAdmin(attempt, controller.signal).then(() => {
      if (mountedRef.current && !controller.signal.aborted) onUnlocked();
    }).catch((failure: unknown) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      const key = adminErrorKey(failure);
      setError(key ? { key } : errorNotice(failure, 'config.loginFailed'));
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mountedRef.current) setBusy(false);
    });
  };

  const shown = error ?? notice;
  return (
    <form className="ov-admin-unlock" noValidate onSubmit={submit}>
      {defaultPassword ? <p className="ov-control-warn" role="note">{t('control.defaultPassword')}</p> : null}
      {disabled ? <p className="ov-control-warn">{t('control.disabled')}</p> : null}
      <label htmlFor={inputId}>{t('control.password')}</label>
      <div className="ov-admin-row">
        <input
          id={inputId}
          type="password"
          value={password}
          autoComplete="current-password"
          disabled={disabled || busy}
          aria-invalid={error ? true : undefined}
          className={error ? 'is-error' : undefined}
          onChange={(event) => { setPassword(event.target.value); setError(null); }}
        />
        <button className="ov-button is-primary" type="submit" disabled={disabled || busy || !password}>{t('control.unlock')}</button>
      </div>
      <p className="ov-admin-message" aria-live="polite">{shown ? noticeText(t, shown) : ''}</p>
    </form>
  );
}
