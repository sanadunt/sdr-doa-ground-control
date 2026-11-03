import type { JSX } from 'react';
import { useState } from 'react';

/**
 * One map notice (basemap unavailable, overlay held, the REFERENCE compass
 * notice with its link). In the compact touch layout it is a one-line chip
 * that ends in an ellipsis; a tap opens the whole notice with its link and a
 * second tap folds it again. Every notice keeps the warning colour.
 */
export function MapNoticeChip({ text, action = null, compact = false }: {
  text: string;
  /** The link that fixes the cause, e.g. Configuration → GPS & Compass. */
  action?: { label: string; onClick: () => void } | null;
  compact?: boolean;
}): JSX.Element {
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
  return (
    <div className={`map-data-chip is-compact${expanded ? ' is-expanded' : ''}`} role="status">
      <button type="button" className="map-chip-toggle" aria-expanded={expanded} title={expanded ? undefined : text} onClick={() => setExpanded(!expanded)}>
        <span className="map-chip-text">{text}</span>
      </button>
      {expanded && action ? <button type="button" className="map-chip-action" onClick={action.onClick}>{action.label}</button> : null}
    </div>
  );
}
