import type { JSX, ReactNode } from 'react';
import { joinClasses } from './Layout';
import type { PageTone } from './pageContext';

/** A row of stat tiles with 1 px separators; tiles wrap (min 132 px each). Put it in a headless flush Card. */
export function StatRow({ label, className, children }: { label?: string; className?: string; children: ReactNode }): JSX.Element {
  return <div className={joinClasses('pg-stats', className)} role={label ? 'group' : undefined} aria-label={label}>{children}</div>;
}

/**
 * One stat: micro-label, a 22 px mono value (tone colours the value only),
 * an optional unit and a short sub value (a count or an age, never prose).
 */
export function StatTile({ label, value, unit, tone, sub, title, className }: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  tone?: PageTone;
  sub?: ReactNode;
  /** A current cause, e.g. the failing flags. */
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={joinClasses('pg-stat', tone && `tone-${tone}`, className)} title={title}>
      <span className="pg-stat-label">{label}</span>
      <strong className="pg-stat-value">{value}{unit !== undefined && unit !== null ? <small className="pg-stat-unit">{unit}</small> : null}</strong>
      {sub !== undefined && sub !== null && sub !== '' ? <span className="pg-stat-sub">{sub}</span> : null}
    </div>
  );
}
