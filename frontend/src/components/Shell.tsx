import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Branding, TelemetrySnapshot, Tone } from '../types';
import { deriveDataState, toneFor } from '../lib/telemetry';
import { polarDataReady } from '../lib/telemetry';
import { Icon, StatusBadge } from './ui';

export type RouteName = 'overview' | 'system-health' | 'doa-diagnostics' | 'configuration' | 'message-monitor' | 'simulation';

export const ROUTES: Array<{ id: RouteName; label: string; icon: Parameters<typeof Icon>[0]['name']; hint: string }> = [
  { id: 'overview', label: 'Overview', icon: 'overview', hint: 'Map and polar view' },
  { id: 'system-health', label: 'System Health', icon: 'health', hint: 'Summary and subsystems' },
  { id: 'doa-diagnostics', label: 'DoA Diagnostics', icon: 'diagnostics', hint: 'Gates and operator log' },
  { id: 'configuration', label: 'Configuration', icon: 'configuration', hint: 'Local settings and dry-run' },
  { id: 'message-monitor', label: 'Message Monitor', icon: 'monitor', hint: 'Subscriber metrics' },
  { id: 'simulation', label: 'Simulasi', icon: 'polar', hint: 'Local synthetic preview' },
];

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


function brandInitials(name: string): string {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  return initials || 'SD';
}

export function ConsoleShell({
  route,
  onNavigate,
  branding,
  snapshot,
  localSnapshotFresh,
  loading,
  readError,
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
  mqttConnection?: string;
  simulationEnabled: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const dataState = localSnapshotFresh ? deriveDataState(snapshot, Boolean(readError)) : snapshot ? 'STALE' : deriveDataState(snapshot, Boolean(readError));
  const dataTone: Tone = readError ? 'bad' : toneFor(dataState);
  const doaState = localSnapshotFresh && polarDataReady(snapshot) ? 'AVAILABLE' : 'UNAVAILABLE';
  const gate = String(snapshot?.publication_gate?.state ?? 'BLOCKED').toUpperCase();
  const snapshotState = readError ? 'ERROR' : localSnapshotFresh ? 'CURRENT' : snapshot ? 'STALE' : loading ? 'LOADING' : 'WAITING';
  const snapshotTone: Tone = readError ? 'bad' : localSnapshotFresh ? 'good' : snapshot ? 'warn' : loading ? 'neutral' : 'warn';
  const mqttState = (mqttConnection ?? 'OFF').toUpperCase();
  const mqttTone: Tone = mqttState === 'CONNECTED' ? 'good' : mqttState === 'OFF' || mqttState === 'DISABLED' ? 'neutral' : 'warn';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const toggleMenu = () => {
    const opening = !menuOpen;
    setMenuOpen(opening);
    if (opening) window.requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>('.nav-item')?.focus());
  };
  const closeMenu = () => {
    setMenuOpen(false);
    window.requestAnimationFrame(() => menuToggleRef.current?.focus());
  };
  const navigateFromMenu = (next: RouteName) => {
    const sameRoute = next === route;
    onNavigate(next);
    setMenuOpen(false);
    if (sameRoute) window.requestAnimationFrame(() => menuToggleRef.current?.focus());
  };
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        window.requestAnimationFrame(() => menuToggleRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('sdr-console-theme') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('sdr-console-theme', theme); } catch { /* Storage may be disabled. */ }
    window.dispatchEvent(new Event('console-theme-change'));
  }, [theme]);
  return (
    <div className={`console-shell${menuOpen ? ' menu-open' : ''}${route === 'overview' ? ' is-overview' : ''}`}>
      <a className="skip-link" href="#console-content">Skip to workspace</a>
      <aside id="console-navigation" className="sidebar" hidden={!menuOpen}>
        <div className="brand-lockup">
          {branding.logo_data_url ? <img className="brand-logo" src={branding.logo_data_url} alt="" /> : <span className="brand-mark">{brandInitials(branding.app_name)}</span>}
          <div>
            <div className="brand-name">{branding.app_name || 'SDR-DoA'}</div>
            <div className="brand-caption">Ground station</div>
          </div>
        </div>
        <button className="secondary-button sidebar-close" type="button" onClick={closeMenu}>Close menu</button>
        <div className="sidebar-rule" />
        <nav ref={navRef} aria-label="Primary navigation" className="primary-nav">
          {ROUTES.map((item) => (
            <button
              className={`nav-item ${route === item.id ? 'nav-active' : ''}`}
              key={item.id}
              type="button"
              aria-current={route === item.id ? 'page' : undefined}
              onClick={() => navigateFromMenu(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="local-chip"><Icon name="lock" /> Read-only console</div>
          <p>Observe locally.<br />Remote control stays disabled.</p>
        </div>
      </aside>
      <div className="console-main">
        <header className="topbar">
          <button ref={menuToggleRef} className="menu-toggle secondary-button" type="button" onClick={toggleMenu} aria-controls="console-navigation" aria-expanded={menuOpen}>{menuOpen ? 'Hide menu' : 'Menu'}</button>
          <div className="topbar-statuses" role="group" aria-label="Runtime status">
            <StatusBadge label={`DATA · ${readError ? 'ERROR' : dataState}`} tone={dataTone} />
            <StatusBadge label={`DOA · ${doaState}`} tone={doaState === 'AVAILABLE' ? 'good' : 'warn'} />
            <StatusBadge label={`DELIVERY · ${gate}`} tone={gate === 'READY' ? 'good' : 'warn'} />
            <span className={`status-badge status-${snapshotTone}`} role="status" aria-live="polite" aria-label={readError ? `Snapshot error: ${readError}` : `Snapshot ${snapshotState}`} title={readError ?? `Snapshot ${snapshotState}`}>
              <i aria-hidden="true" />SNAPSHOT · {snapshotState}
            </span>
            <span className={`status-badge status-${mqttTone}`} aria-label={`MQTT ${mqttState}, subscriber-only monitor`} title="Subscriber-only monitor">
              <i aria-hidden="true" />MQTT · {mqttState}
            </span>
            <StatusBadge label={simulationEnabled ? 'SIMULATION · ON' : 'SIMULATION · OFF'} tone={simulationEnabled ? 'warn' : 'neutral'} />
          </div>
          <div className="topbar-tools">
            <button className="theme-button secondary-button" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh Data Out snapshot" title="Refresh Data Out">
              <Icon name="refresh" />
            </button>
          </div>
        </header>
        <main id="console-content" tabIndex={-1} aria-label={route === 'overview' ? 'Overview map and polar plot' : undefined} className={`page-content ${route === 'overview' ? 'page-content-overview' : ''}`}>{children}</main>
        <footer className="console-footer">
          <span>Ground Console · Local observation</span>
          <span>No remote writes · Angular vectors remain local</span>
        </footer>
      </div>
    </div>
  );
}
