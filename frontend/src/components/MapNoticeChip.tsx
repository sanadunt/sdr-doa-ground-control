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
 * notice with its link). In the compact touch layout it is a one-line chip;
 * a tap folds it to a small "ⓘ" mark, so it stops covering the map. The mark
 * opens the whole notice with its link, and a tap there folds it again. A
 * notice of another cause shows whole again. Every notice keeps the warning colour.
 */
export function MapNoticeChip({ text, action = null, compact = false }: {
  text: string;
  /** The link that fixes the cause, e.g. Configuration → GPS & Compass. */
  action?: { label: string; onClick: () => void } | null;
  compact?: boolean;
}): JSX.Element {
  const key = noticeKey(text);
  const [folded, setFolded] = useState(() => dismissed.has(key));
  const [expanded, setExpanded] = useState(false);
  if (!compact) {
    if (!action) return <div className="map-data-chip" role="status">{text}</div>;
    return (
      <div className="map-data-chip has-action" role="status">
        <span>{text}</span>
        <button type="button" className="map-chip-action" onClick={action.onClick}>{action.label}</button>
      </div>
    );
  }
  const fold = () => {
    foldNotice(text);
    setFolded(true);
    setExpanded(false);
  };
  if (folded && !expanded) {
    return (
      <div className="map-data-chip is-compact is-folded" role="status">
        <button type="button" className="map-chip-flag" aria-label={text} title={text} onClick={() => setExpanded(true)}>ⓘ</button>
      </div>
    );
  }
  return (
    <div className={`map-data-chip is-compact${expanded ? ' is-expanded' : ''}`} role="status">
      <button type="button" className="map-chip-toggle" title={expanded ? undefined : text} onClick={fold}>
        <span className="map-chip-text">{text}</span>
      </button>
      {expanded && action ? <button type="button" className="map-chip-action" onClick={action.onClick}>{action.label}</button> : null}
    </div>
  );
}
