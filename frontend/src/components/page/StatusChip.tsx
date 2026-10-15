import type { JSX, ReactNode } from 'react';
import { stateTone } from '../../lib/healthView';
import { joinClasses } from './Layout';
import type { PageTone } from './pageContext';

/**
 * A state code as a pill (same look as the Dashboard's ov-chip). Codes stay
 * untranslated. The tone defaults to the console's state mapping
 * (stateTone: PASS/VALID/ADVANCING good, STALLED/OVERDRIVE bad, …). With a
 * label it renders as "LABEL [CODE]" for the page bar.
 */
export function StatusChip({ code, tone, label, title, className }: {
  code: ReactNode;
  tone?: PageTone;
  /** Micro-label before the pill, e.g. "HTTP" in "HTTP AVAILABLE". */
  label?: ReactNode;
  /** A current cause, never a definition. */
  title?: string;
  className?: string;
}): JSX.Element {
  const resolved = tone ?? stateTone(typeof code === 'string' || typeof code === 'number' ? code : '');
  const chip = <span className={joinClasses('ov-chip', `tone-${resolved}`, label === undefined && className)} title={label === undefined ? title : undefined}>{code}</span>;
  if (label === undefined) return chip;
  return <span className={joinClasses('pg-chip', className)} title={title}><span className="pg-chip-label">{label}</span>{chip}</span>;
}

/** A source label such as SYNTHETIC, MOCK, DATA_OUT, MANUAL or DRY-RUN (neutral by default, signal for MANUAL). */
export function Tag({ children, tone = 'neutral', title, className }: { children: ReactNode; tone?: PageTone; title?: string; className?: string }): JSX.Element {
  return <span className={joinClasses('ov-tag', `tone-${tone}`, className)} title={title}>{children}</span>;
}
