import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useI18n } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { isTextEntryTarget } from '../lib/shortcuts';
import { consoleRequestsMockSdr } from '../lib/receiverBridge';
import type { ReceiverBridge } from '../lib/receiverBridge';

// The Overview dock shares the mock rule, so it lives with the bridge.
export { consoleRequestsMockSdr };

function consoleTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** The Receiver reads theme and language from its URL before its first paint. */
export function receiverFrameSrc(theme: 'light' | 'dark', lang: Lang, mock = false): string {
  const params = new URLSearchParams({ theme, lang });
  if (mock) params.set('mock', '1');
  return `/receiver/?${params.toString()}`;
}

const SHORTCUT_KEY = /^[1-9rR]$/;

/**
 * Re-dispatch a console shortcut typed inside the Receiver frame on the
 * console window, where the shell handles it. Keys typed into a field, or
 * already handled by the Receiver, stay in the frame.
 */
export function forwardFrameShortcut(event: KeyboardEvent, target: Window): boolean {
  if (event.defaultPrevented || !SHORTCUT_KEY.test(event.key) || isTextEntryTarget(event.target)) return false;
  const forwarded = new KeyboardEvent('keydown', {
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(forwarded);
  if (forwarded.defaultPrevented) event.preventDefault();
  return forwarded.defaultPrevented;
}

function receiverWindow(frame: HTMLIFrameElement | null): Window | null {
  const frameWindow = frame?.contentWindow;
  if (!frameWindow) return null;
  try {
    if (frameWindow.location.origin !== window.location.origin || !frameWindow.location.pathname.startsWith('/receiver/')) return null;
    return frameWindow;
  } catch {
    // A navigated frame may no longer be same-origin.
    return null;
  }
}

export function ReceiverPage({ bridge, visible = true }: {
  /** The console's Receiver bridge; bound to the frame on every load. */
  bridge?: ReceiverBridge;
  /** The Receiver route is showing (the frame stays mounted, hidden, on other routes). */
  visible?: boolean;
} = {}): JSX.Element {
  const { t, lang } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  // Changing the iframe URL would reload the Receiver and stop RX, so later
  // theme and language changes are pushed into the loaded frame instead.
  const [src] = useState(() => receiverFrameSrc(consoleTheme(), lang, consoleRequestsMockSdr(window.location)));

  // Focus inside the frame would otherwise swallow the console's 1-7 and R keys.
  const onFrameKeyDown = useRef((event: KeyboardEvent) => { forwardFrameShortcut(event, window); }).current;

  const syncFrame = () => {
    const frameWindow = receiverWindow(frameRef.current);
    if (!frameWindow) return;
    try {
      // Every load is a new document, so the listener is attached again.
      frameWindow.removeEventListener('keydown', onFrameKeyDown);
      frameWindow.addEventListener('keydown', onFrameKeyDown);
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

  // Each load is a new Receiver document, so the bridge binds to it again.
  // Only a loaded /receiver/ document counts; the initial about:blank does not.
  const attachBridge = () => {
    const frameWindow = receiverWindow(frameRef.current);
    if (frameWindow) bridgeRef.current?.attach(frameWindow);
  };

  const onFrameLoad = () => {
    syncFrame();
    attachBridge();
  };

  useEffect(() => {
    const frame = frameRef.current;
    const attached = bridgeRef.current;
    window.addEventListener('console-theme-change', syncFrame);
    syncFrame();
    // A remount (StrictMode) finds the frame already loaded and no new load event.
    attachBridge();
    return () => {
      window.removeEventListener('console-theme-change', syncFrame);
      receiverWindow(frame)?.removeEventListener('keydown', onFrameKeyDown);
      attached?.detach();
    };
  }, []);

  useEffect(() => {
    syncFrame();
  }, [lang]);

  // Shown again after being hidden: the frame's canvases were sized 0x0 while
  // display:none, and console-theme-change makes the Receiver resize them.
  useEffect(() => {
    if (visible) syncFrame();
  }, [visible]);

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
        onLoad={onFrameLoad}
      />
    </div>
  );
}
