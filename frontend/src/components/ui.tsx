import type { JSX, ReactNode } from 'react';
import type { Tone } from '../types';
import { toneFor } from '../lib/telemetry';

export function StatusBadge({ label, tone = toneFor(label) }: { label: string; tone?: Tone }): JSX.Element {
  return <span className={`status-badge status-${tone}`}><i aria-hidden="true" />{label}</span>;
}

export function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone }): JSX.Element {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </article>
  );
}

export function Panel({
  children,
  className = '',
  title,
  eyebrow,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <section className={`panel ${className}`}>
      {(title || eyebrow || action) ? (
        <header className="panel-header">
          <div>
            {eyebrow ? <div className="panel-eyebrow">{eyebrow}</div> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {action ? <div className="panel-action">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }): JSX.Element {
  return (
    <div className="section-heading">
      {/* The shell header already shows the page name, so the h1 stays for
          screen readers and route focus only. */}
      <h1 className="visually-hidden" data-route-focus tabIndex={-1}>{title}</h1>
      <div className="panel-eyebrow">{eyebrow}</div>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}

export function EmptyState({ label, detail, tone = 'neutral' }: { label: string; detail: string; tone?: Tone }): JSX.Element {
  return (
    <div className={`empty-state empty-${tone}`} role="status">
      <span className="empty-state-mark" aria-hidden="true">·</span>
      <strong>{label}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function KeyValue({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }): JSX.Element {
  return (
    <div className="key-value">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export type IconName = 'overview' | 'health' | 'diagnostics' | 'configuration' | 'monitor' | 'receiver' | 'refresh' | 'lock' | 'map' | 'polar' | 'menu' | 'close' | 'sun' | 'moon' | 'chevron-left' | 'chevron-right' | 'layers' | 'expand' | 'collapse' | 'crosshair';

export function Icon({ name }: { name: IconName }): JSX.Element {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    health: <><path d="M4 12h3l2-6 4 12 2-6h5" /><path d="M3 4h18v16H3z" /></>,
    diagnostics: <><path d="M4 19V5" /><path d="M4 19h17" /><path d="m7 15 3-4 3 2 5-7" /><circle cx="18" cy="6" r="1.5" /></>,
    configuration: <><path d="M12 3v3" /><path d="M12 18v3" /><path d="m4.2 7.5 2.6 1.5" /><path d="m17.2 15 2.6 1.5" /><path d="m4.2 16.5 2.6-1.5" /><path d="m17.2 9 2.6-1.5" /><circle cx="12" cy="12" r="4" /></>,
    monitor: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 18v3" /><path d="M7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h.01M15 13h.01" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.8-4L3 10" /><path d="M3 5v5h5" /><path d="M4 13a8 8 0 0 0 14.8 4L21 14" /><path d="M21 19v-5h-5" /></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15" /><path d="M15 6v15" /></>,
    polar: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 4v16M4 12h16" /></>,
    receiver: <><path d="M4 17c2.5-3.5 5-3.5 8 0s5.5 3.5 8 0" /><path d="M4 12c2.5-3.5 5-3.5 8 0s5.5 3.5 8 0" /><path d="M4 7c2.5-3.5 5-3.5 8 0s5.5 3.5 8 0" /></>,
    menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
    'chevron-left': <path d="m15 6-6 6 6 6" />,
    'chevron-right': <path d="m9 6 6 6-6 6" />,
    layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
    expand: <><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>,
    collapse: <><path d="M9 4v5H4" /><path d="M15 4v5h5" /><path d="M9 20v-5H4" /><path d="M15 20v-5h5" /></>,
    crosshair: <><circle cx="12" cy="12" r="7" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}
