import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useI18n } from '../lib/i18n';
import type { Lang } from '../lib/i18n';

function consoleTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** The Receiver reads theme and language from its URL before its first paint. */
export function receiverFrameSrc(theme: 'light' | 'dark', lang: Lang): string {
  const params = new URLSearchParams({ theme, lang });
  return `/receiver/?${params.toString()}`;
}

export function ReceiverPage(): JSX.Element {
  const { t, lang } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  // Changing the iframe URL would reload the Receiver and stop RX, so later
  // theme and language changes are pushed into the loaded frame instead.
  const [src] = useState(() => receiverFrameSrc(consoleTheme(), lang));

  const syncFrame = () => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) return;
    try {
      if (frameWindow.location.origin !== window.location.origin || !frameWindow.location.pathname.startsWith('/receiver/')) return;
      const root = frameWindow.document.documentElement;
      root.dataset.theme = consoleTheme();
      if (root.lang !== langRef.current) {
        root.lang = langRef.current;
        frameWindow.dispatchEvent(new CustomEvent('console-language-change', { detail: langRef.current }));
      }
      frameWindow.dispatchEvent(new Event('console-theme-change'));
    } catch {
      // A navigated frame may no longer be same-origin.
    }
  };

  useEffect(() => {
    window.addEventListener('console-theme-change', syncFrame);
    syncFrame();
    return () => window.removeEventListener('console-theme-change', syncFrame);
  }, []);

  useEffect(() => {
    syncFrame();
  }, [lang]);

  return (
    <div className="page page-receiver">
      <h1 className="visually-hidden" data-route-focus tabIndex={-1}>{t('route.receiver')}</h1>
      <iframe
        ref={frameRef}
        className="receiver-frame"
        src={src}
        title={t('route.receiver')}
        allow="usb; autoplay"
        loading="eager"
        onLoad={syncFrame}
      />
    </div>
  );
}
