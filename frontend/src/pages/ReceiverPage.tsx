import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { useI18n } from '../lib/i18n';

export function ReceiverPage(): JSX.Element {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);

  const syncTheme = () => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) return;
    try {
      if (frameWindow.location.origin !== window.location.origin || !frameWindow.location.pathname.startsWith('/receiver/')) return;
      frameWindow.document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      frameWindow.dispatchEvent(new Event('console-theme-change'));
    } catch {
      // A navigated frame may no longer be same-origin.
    }
  };

  useEffect(() => {
    window.addEventListener('console-theme-change', syncTheme);
    syncTheme();
    return () => window.removeEventListener('console-theme-change', syncTheme);
  }, []);

  return (
    <div className="page page-receiver">
      <h1 className="visually-hidden" data-route-focus tabIndex={-1}>{t('route.receiver')}</h1>
      <iframe
        ref={frameRef}
        className="receiver-frame"
        src="/receiver/"
        title={t('route.receiver')}
        allow="usb; autoplay"
        loading="eager"
        onLoad={syncTheme}
      />
    </div>
  );
}
