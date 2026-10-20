import type { JSX } from 'react';
import { joinClasses } from './Layout';
import type { PageTone } from './pageContext';

/** One short line for "nothing here yet" (e.g. "No v2 messages yet"), with a state code chip. Never a paragraph. */
export function EmptyState({ label, code = 'NO DATA', tone = 'neutral', className }: {
  label: string;
  /** Chip text; null hides the chip. */
  code?: string | null;
  tone?: PageTone;
  className?: string;
}): JSX.Element {
  return (
    <div className={joinClasses('pg-empty', className)} role="status">
      {code ? <span className={`ov-chip tone-${tone}`}>{code}</span> : null}
      <span>{label}</span>
    </div>
  );
}
