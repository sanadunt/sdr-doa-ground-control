import type { JSX, ReactNode } from 'react';
import { joinClasses } from './Layout';
import { usePageReadAge } from './pageContext';

/**
 * The page bar: the page's key state chips and its actions. It holds the
 * page's H1, which takes the route focus after a page change. Above 600 px
 * the H1 is visually hidden because the top bar already names the page; at
 * 600 px and below the top-bar title is hidden and this H1 shows instead,
 * with the read age under it.
 */
export function PageHeader({
  title,
  chips,
  actions,
  readAge,
  className,
  children,
}: {
  /** The page name, the same text as the menu label (t('route.<id>')). */
  title: string;
  /** StatusChip / Tag elements for the page's key verdicts. */
  chips?: ReactNode;
  /** Outline ov-buttons; at most one is-primary. */
  actions?: ReactNode;
  /** Overrides the read age from the shell (tests); null hides it. */
  readAge?: string | null;
  className?: string;
  /** A full-width row under chips and actions, e.g. a section index. */
  children?: ReactNode;
}): JSX.Element {
  const shellReadAge = usePageReadAge();
  const read = readAge === undefined ? shellReadAge : readAge;
  const bare = !chips && !actions && !children;
  return (
    <header className={joinClasses('pg-bar', bare && 'is-bare', className)}>
      <div className="pg-bar-heading">
        <h1 className="pg-bar-title" data-route-focus tabIndex={-1}>{title}</h1>
        {read ? <span className="pg-bar-read">{read}</span> : null}
      </div>
      {chips ? <div className="pg-bar-chips">{chips}</div> : null}
      {actions ? <span className="pg-bar-spacer" aria-hidden="true" /> : null}
      {actions ? <div className="pg-bar-actions">{actions}</div> : null}
      {children ? <div className="pg-bar-row">{children}</div> : null}
    </header>
  );
}
