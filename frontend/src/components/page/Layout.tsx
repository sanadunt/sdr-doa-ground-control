import type { JSX, ReactNode } from 'react';

/** Grid spans of the 12-column page grid. Below 1280 px 3/4 become 6 and 5/7/8 become 12; below 1024 px every span is 12. */
export type PageSpan = 3 | 4 | 5 | 6 | 7 | 8 | 12;

export function spanClass(span: PageSpan | undefined): string {
  return span === undefined ? '' : `pg-span-${span}`;
}

export function joinClasses(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** Root of every page except the Dashboard and the Receiver: the page bar, then the grid. */
export function Page({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return <div className={joinClasses('page pg', className)}>{children}</div>;
}

/** 12-column grid of cards (gap 12 px, cards keep their own height). */
export function PageGrid({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return <div className={joinClasses('pg-grid', className)}>{children}</div>;
}

/** A column of cards inside one grid cell, so they do not stretch to the neighbour's height. */
export function PageStack({ span = 12, className, children }: { span?: PageSpan; className?: string; children: ReactNode }): JSX.Element {
  return <div className={joinClasses('pg-stack', spanClass(span), className)}>{children}</div>;
}

/** A row of controls that wraps: inside card heads, above tables, in the page bar. */
export function Toolbar({ className, label, children }: { className?: string; label?: string; children: ReactNode }): JSX.Element {
  return <div className={joinClasses('pg-toolbar', className)} role={label ? 'group' : undefined} aria-label={label}>{children}</div>;
}
