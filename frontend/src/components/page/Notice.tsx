import type { JSX, ReactNode } from 'react';
import { joinClasses } from './Layout';

/**
 * A current condition that needs attention or an action (STALE EVIDENCE, a
 * read error, default admin password, MQTT without TLS on a non-loopback
 * host, synthetic data). Never for permanent policy text.
 */
export function Notice({ tone = 'warn', title, action, role, className, children }: {
  tone?: 'warn' | 'bad' | 'info' | 'good';
  /** A code or short label in mono before the text, e.g. STALE EVIDENCE. */
  title?: ReactNode;
  /** A button that resolves the condition. */
  action?: ReactNode;
  /** Defaults to alert for bad, status otherwise. */
  role?: 'alert' | 'status' | 'note';
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={joinClasses('pg-notice', `tone-${tone}`, className)} role={role ?? (tone === 'bad' ? 'alert' : 'status')}>
      {title !== undefined && title !== null ? <strong className="pg-notice-title">{title}</strong> : null}
      {children !== undefined && children !== null ? <span className="pg-notice-text">{children}</span> : null}
      {action ? <span className="pg-notice-action">{action}</span> : null}
    </div>
  );
}
