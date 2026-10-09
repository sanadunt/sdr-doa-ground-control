import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Branding, TelemetrySnapshot, Tone } from '../types';
import { deriveDataState, toneFor } from '../lib/telemetry';
import { polarDataReady } from '../lib/telemetry';
import { LANGS, useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import { Icon } from './ui';
import type { IconName } from './ui';

export type RouteName = 'overview' | 'system-health' | 'doa-diagnostics' | 'configuration' | 'message-monitor' | 'simulation' | 'receiver';

export const ROUTES: Array<{ id: RouteName; icon: IconName }> = [
  { id: 'overview', icon: 'overview' },
  { id: 'system-health', icon: 'health' },
  { id: 'doa-diagnostics', icon: 'diagnostics' },
  { id: 'configuration', icon: 'configuration' },
  { id: 'message-monitor', icon: 'monitor' },
  { id: 'simulation', icon: 'polar' },
  { id: 'receiver', icon: 'receiver' },
];

const RAIL_STORAGE_KEY = 'sdr-console-rail';
const DESKTOP_QUERY = '(min-width: 1024px)';

function routeFromHash(): RouteName {
  const value = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (ROUTES.some((route) => route.id === value)) return value as RouteName;
  if (value === 'live-doa' || value === 'map') return 'overview';
  if (value === 'health') return 'system-health';
  if (value === 'diagnostics') return 'doa-diagnostics';
  if (value === 'settings') return 'configuration';
  if (value === 'mqtt') return 'message-monitor';
  return 'overview';
}

export function useRoute(): [RouteName, (route: RouteName) => void] {
  const [route, setRoute] = useState<RouteName>(() => routeFromHash());
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return [route, (next) => {
    if (routeFromHash() === next) return;
    window.location.hash = `/${next}`;
  }];
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

function brandInitials(name: string): string {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  return initials || 'SD';
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

function TelemetryItem({ label, value, tone, title, live }: { label: string; value: string; tone: Tone; title?: string; live?: boolean }): JSX.Element {
  return (
    <span className={`telemetry-item tone-${tone}`} title={title} role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined}>
      <span className="telemetry-key">{label}</span>
      <span className="telemetry-value"><i aria-hidden="true" />{value}</span>
    </span>
  );
}

export function ConsoleShell({
  route,
  onNavigate,
  branding,
  snapshot,
  localSnapshotFresh,
  loading,
  readError,
  lastReadAgeMs,
  mqttConnection,
  simulationEnabled,
  onRefresh,
  children,
}: {
  route: RouteName;
  onNavigate: (route: RouteName) => void;
  branding: Branding;
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  loading: boolean;
  readError: string | null;
  lastReadAgeMs: number | null;
  mqttConnection?: string;
  simulationEnabled: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const { lang, setLang, t } = useI18n();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const dataState = localSnapshotFresh ? deriveDataState(snapshot, Boolean(readError)) : snapshot ? 'STALE' : deriveDataState(snapshot, Boolean(readError));
  const dataTone: Tone = readError ? 'bad' : toneFor(dataState);
  const doaState = localSnapshotFresh && polarDataReady(snapshot) ? 'AVAILABLE' : 'UNAVAILABLE';
  const gate = String(snapshot?.publication_gate?.state ?? 'BLOCKED').toUpperCase();
  const snapshotState = readError ? 'ERROR' : localSnapshotFresh ? 'CURRENT' : snapshot ? 'STALE' : loading ? 'LOADING' : 'WAITING';
  const snapshotTone: Tone = readError ? 'bad' : localSnapshotFresh ? 'good' : snapshot ? 'warn' : loading ? 'neutral' : 'warn';
  const mqttState = (mqttConnection ?? 'OFF').toUpperCase();
  const mqttTone: Tone = mqttState === 'CONNECTED' ? 'good' : mqttState === 'OFF' || mqttState === 'DISABLED' ? 'neutral' : 'warn';
  const readLabel = loading ? t('shell.reading') : lastReadAgeMs === null ? t('shell.noRead') : t('shell.lastRead', { age: formatElapsed(lastReadAgeMs) });

  const [menuOpen, setMenuOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_STORAGE_KEY) === 'collapsed'; } catch { return false; }
  });
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const drawerOpen = !desktop && menuOpen;

  useEffect(() => {
    if (desktop) setMenuOpen(false);
  }, [desktop]);
  useEffect(() => {
    try { localStorage.setItem(RAIL_STORAGE_KEY, railCollapsed ? 'collapsed' : 'expanded'); } catch { /* Storage may be disabled. */ }
  }, [railCollapsed]);

  const openMenu = () => {
    setMenuOpen(true);
    window.requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>('.nav-item')?.focus());
  };
  const closeMenu = () => {
    setMenuOpen(false);
    window.requestAnimationFrame(() => menuToggleRef.current?.focus());
  };
  const navigate = (next: RouteName) => {
    onNavigate(next);
    if (drawerOpen) closeMenu();
  };

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        window.requestAnimationFrame(() => menuToggleRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  // Single-key shortcuts for page switching and refresh. They never fire while
  // the operator types in a field or holds a modifier.
  const shortcutRef = useRef({ onNavigate, onRefresh, loading });
  shortcutRef.current = { onNavigate, onRefresh, loading };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || editableTarget(event.target)) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < ROUTES.length) {
        event.preventDefault();
        shortcutRef.current.onNavigate(ROUTES[index].id);
      } else if (event.key === 'r' || event.key === 'R') {
        if (shortcutRef.current.loading) return;
        event.preventDefault();
        shortcutRef.current.onRefresh();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('sdr-console-theme') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('sdr-console-theme', theme); } catch { /* Storage may be disabled. */ }
    window.dispatchEvent(new Event('console-theme-change'));
  }, [theme]);

  const shellClass = [
    'console-shell',
    route === 'overview' ? 'is-overview' : '',
    route === 'receiver' ? 'is-receiver' : '',
    desktop && railCollapsed ? 'rail-collapsed' : '',
    drawerOpen ? 'menu-open' : '',
  ].filter(Boolean).join(' ');
  const routeLabel = t(`route.${route}` as MessageKey);

  return (
    <div className={shellClass}>
      <a className="skip-link" href="#console-content">{t('shell.skip')}</a>
      {drawerOpen ? <div className="drawer-backdrop" aria-hidden="true" onClick={closeMenu} /> : null}
      <aside id="console-navigation" className="sidebar" hidden={!desktop && !menuOpen}>
        <div className="brand-lockup">
          {branding.logo_data_url ? <img className="brand-logo" src={branding.logo_data_url} alt="" /> : <span className="brand-mark">{brandInitials(branding.app_name)}</span>}
          <div className="brand-text">
            <div className="brand-name" title={branding.app_name || 'SDR-DoA'}>{branding.app_name || 'SDR-DoA'}</div>
            <div className="brand-caption">{t('shell.brandCaption')}</div>
          </div>
          {!desktop ? <button className="icon-button sidebar-close" type="button" onClick={closeMenu} aria-label={t('shell.closeMenu')}><Icon name="close" /></button> : null}
        </div>
        <nav ref={navRef} aria-label={t('shell.primaryNav')} className="primary-nav">
          {ROUTES.map((item, index) => {
            const label = t(`route.${item.id}` as MessageKey);
            const hint = t(`route.${item.id}.hint` as MessageKey);
            return (
              <button
                className={`nav-item ${route === item.id ? 'nav-active' : ''}`}
                key={item.id}
                type="button"
                aria-current={route === item.id ? 'page' : undefined}
                aria-keyshortcuts={String(index + 1)}
                title={desktop && railCollapsed ? `${label} (${index + 1})` : hint}
                onClick={() => navigate(item.id)}
              >
                <Icon name={item.icon} />
                <span className="nav-label">{label}</span>
                <kbd aria-hidden="true">{index + 1}</kbd>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="local-chip" title={t('shell.readOnlyDetail')}><Icon name="lock" /><span>{t('shell.readOnly')}</span></div>
          <p className="shortcut-hint">{t('shell.shortcutHint')}</p>
          {desktop ? (
            <button className="rail-toggle" type="button" onClick={() => setRailCollapsed(!railCollapsed)} aria-label={railCollapsed ? t('shell.expand') : t('shell.collapse')} title={railCollapsed ? t('shell.expand') : t('shell.collapse')}>
              <Icon name={railCollapsed ? 'chevron-right' : 'chevron-left'} />
            </button>
          ) : null}
        </div>
      </aside>
      <div className="console-main">
        <header className="topbar">
          {!desktop ? (
            <button ref={menuToggleRef} className="icon-button menu-toggle" type="button" onClick={() => (menuOpen ? closeMenu() : openMenu())} aria-controls="console-navigation" aria-expanded={menuOpen} aria-label={menuOpen ? t('shell.closeMenu') : t('shell.menu')}>
              <Icon name="menu" />
            </button>
          ) : null}
          <div className="topbar-title">
            <span className="topbar-route">{routeLabel}</span>
            <span className="topbar-read">{readLabel}</span>
          </div>
          <div className="telemetry-strip" role="group" aria-label={t('shell.runtimeStatus')}>
            <TelemetryItem label={t('status.data')} value={readError ? 'ERROR' : dataState} tone={dataTone} />
            <TelemetryItem label={t('status.doa')} value={doaState} tone={doaState === 'AVAILABLE' ? 'good' : 'warn'} />
            <TelemetryItem label={t('status.delivery')} value={gate} tone={gate === 'READY' ? 'good' : 'warn'} />
            <TelemetryItem label={t('status.snapshot')} value={snapshotState} tone={snapshotTone} title={readError ? t('shell.snapshotError', { error: readError }) : undefined} live />
            <TelemetryItem label={t('status.mqtt')} value={mqttState} tone={mqttTone} title={t('shell.mqttTitle')} />
            <TelemetryItem label={t('status.sim')} value={simulationEnabled ? 'ON' : 'OFF'} tone={simulationEnabled ? 'warn' : 'neutral'} />
          </div>
          <div className="topbar-tools">
            <div className="lang-switch" role="group" aria-label={t('shell.language')}>
              {LANGS.map((option) => (
                <button key={option} type="button" aria-pressed={lang === option} onClick={() => setLang(option)} lang={option}>{option.toUpperCase()}</button>
              ))}
            </div>
            <button className="icon-button" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? t('shell.themeToLight') : t('shell.themeToDark')} title={theme === 'dark' ? t('shell.themeToLight') : t('shell.themeToDark')}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button className={`icon-button refresh-button${loading ? ' is-loading' : ''}`} type="button" onClick={onRefresh} disabled={loading} aria-label={t('shell.refresh')} aria-keyshortcuts="R" title={t('shell.refreshShortcut')}>
              <Icon name="refresh" />
            </button>
          </div>
        </header>
        <main id="console-content" tabIndex={-1} aria-label={route === 'overview' ? routeLabel : undefined} className={`page-content ${route === 'overview' ? 'page-content-overview' : route === 'receiver' ? 'page-content-receiver' : ''}`}>{children}</main>
        <footer className="console-footer">
          <span>{t('shell.footerLeft')}</span>
          <span>{t('shell.footerRight')}</span>
        </footer>
      </div>
    </div>
  );
}
