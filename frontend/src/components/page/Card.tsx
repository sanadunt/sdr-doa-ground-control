import { useId } from 'react';
import type { JSX, ReactNode } from 'react';
import { joinClasses, spanClass } from './Layout';
import type { PageSpan } from './Layout';

/**
 * A page card: one 44 px head with a noun title (no eyebrow), an optional
 * chip next to the title and actions on the right, then a 12 px body.
 * Without a title the card has no head (e.g. a stat row).
 */
export function Card({
  title,
  chip,
  actions,
  span = 12,
  flush = false,
  id,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode;
  /** StatusChip or Tag shown right after the title. */
  chip?: ReactNode;
  /** Buttons or a meta value at the right end of the head. */
  actions?: ReactNode;
  /** Grid span inside PageGrid (default 12). Ignored inside PageStack. */
  span?: PageSpan;
  /** No body padding or gap: for tables and stat rows that reach the card edge. */
  flush?: boolean;
  /** Element id of the section, e.g. an anchor for a section index. */
  id?: string;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const hasHead = title !== undefined && title !== null && title !== false;
  return (
    <section id={id} className={joinClasses('pg-card', spanClass(span), className)} aria-labelledby={hasHead ? titleId : undefined}>
      {hasHead ? (
        <header className="pg-card-head">
          <h2 id={titleId}>{title}</h2>
          {chip}
          <span className="pg-card-spacer" aria-hidden="true" />
          {actions ? <div className="pg-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined && children !== null ? <div className={joinClasses('pg-card-body', flush && 'is-flush', bodyClassName)}>{children}</div> : null}
    </section>
  );
}
