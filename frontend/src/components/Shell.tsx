import type { JSX } from 'react';
import { useEffect, useState } from 'react';
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

function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <time className="header-clock" dateTime={now.toISOString()}>{now.toISOString().replace('T', ' · ').replace(/\.\d{3}Z$/, 'Z')}</time>;
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
  lastReadAt,
  mqttConnection,
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
  lastReadAt: Date | null;
  mqttConnection?: string;
  onRefresh: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const dataState = localSnapshotFresh ? deriveDataState(snapshot, Boolean(readError)) : snapshot ? 'STALE' : deriveDataState(snapshot, Boolean(readError));
  const dataTone: Tone = readError ? 'bad' : toneFor(dataState);
  const doaState = localSnapshotFresh && polarDataReady(snapshot) ? 'AVAILABLE' : 'UNAVAILABLE';
  const gate = String(snapshot?.publication_gate?.state ?? 'BLOCKED').toUpperCase();
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
    <div className="console-shell">
      <a className="skip-link" href="#console-content">Skip to workspace</a>
      <aside className="sidebar">
        <div className="brand-lockup">
          {branding.logo_data_url ? <img className="brand-logo" src={branding.logo_data_url} alt="" /> : <span className="brand-mark">{brandInitials(branding.app_name)}</span>}
          <div>
            <div className="brand-name">{branding.app_name || 'SDR-DoA'}</div>
            <div className="brand-caption">Ground station</div>
          </div>
        </div>
        <div className="sidebar-rule" />
        <nav aria-label="Primary navigation" className="primary-nav">
          <div className="nav-caption">Workspace</div>
          {ROUTES.map((item) => (
            <button
              className={`nav-item ${route === item.id ? 'nav-active' : ''}`}
              key={item.id}
              type="button"
              aria-current={route === item.id ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
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
          <div className="topbar-title">
            <span className="topbar-kicker">Ground console / Workspace</span>
            <strong>{ROUTES.find((item) => item.id === route)?.label}</strong>
          </div>
          <div className="topbar-statuses" aria-label="Runtime status">
            <StatusBadge label={`DATA · ${readError ? 'ERROR' : dataState}`} tone={dataTone} />
            <StatusBadge label={`DOA · ${doaState}`} tone={doaState === 'AVAILABLE' ? 'good' : 'warn'} />
            <StatusBadge label={`DELIVERY · ${gate}`} tone={gate === 'READY' ? 'good' : 'warn'} />
            <Clock />
            <button className="theme-button secondary-button" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh Data Out snapshot" title="Refresh Data Out">
              <Icon name="refresh" />
            </button>
          </div>
        </header>
        <div className="read-strip" role="status">
          <span className={`read-pulse ${loading ? 'pulse-loading' : dataTone}`} />
          <span>{loading ? 'Reading Data Out…' : readError ? `Read failed · ${readError}` : !snapshot ? 'Waiting for first snapshot' : localSnapshotFresh ? 'Local snapshot current' : 'Local snapshot expired'}</span>
          <span className="read-strip-source">{lastReadAt ? `last read ${lastReadAt.toISOString().replace('T', ' · ').replace(/\.\d{3}Z$/, 'Z')}` : 'no snapshot read yet'}</span>
          {mqttConnection ? <span className="read-strip-source">MQTT {mqttConnection.toUpperCase()} · SUBSCRIBER ONLY</span> : null}
        </div>
        <main id="console-content" tabIndex={-1} className={`page-content ${route === 'overview' ? 'page-content-overview' : ''}`}>{children}</main>
        <footer className="console-footer">
          <span>Ground Console · Local observation</span>
          <span>No remote writes · Angular vectors remain local</span>
        </footer>
      </div>
    </div>
  );
}
