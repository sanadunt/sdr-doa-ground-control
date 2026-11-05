import type { JSX } from 'react';
import { useState } from 'react';

/**
 * A notice's cause without its numbers: the time of the last data and ages
 * change while the cause stays, so a notice folded away stays folded until
 * its cause changes.
 */
export function noticeKey(text: string): string {
  return text.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
}

// Notices the operator folded away, by cause, for the life of the page.
const dismissed = new Set<string>();

/** Fold this notice's cause away for the rest of the page's life. */
export function foldNotice(text: string): void {
  dismissed.add(noticeKey(text));
}

/** Tests only: forget the folded notices. */
export function resetDismissedNotices(): void {
  dismissed.clear();
}

/**
 * One map notice (basemap unavailable, overlay held, the REFERENCE compass
 * notice with its link). In the compact touch layout it is a one-line chip
 * without the link, and a tap removes it until its cause changes (the info row
 * and the tabs still say what it said). Every notice keeps the warning colour.
 */
export function MapNoticeChip({ text, action = null, compact = false }: {
  text: string;
  /** The link that fixes the cause, e.g. Configuration → GPS & Compass. */
  action?: { label: string; onClick: () => void } | null;
  compact?: boolean;
}): JSX.Element | null {
  const [, setDismissals] = useState(0);
  if (!compact) {
    if (!action) return <div className="map-data-chip" role="status">{text}</div>;
    return (
      <div className="map-data-chip has-action" role="status">
        <span>{text}</span>
        <button type="button" className="map-chip-action" onClick={action.onClick}>{action.label}</button>
      </div>
    );
  }
  // A tap removes the notice until its cause changes.
  if (dismissed.has(noticeKey(text))) return null;
  const fold = () => {
    foldNotice(text);
    setDismissals((count) => count + 1);
  };
  return (
    <div className="map-data-chip is-compact" role="status">
      <button type="button" className="map-chip-toggle" title={text} onClick={fold}>
        <span className="map-chip-text">{text}</span>
      </button>
    </div>
  );
}
