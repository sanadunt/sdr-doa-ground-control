import type { JSX, ReactNode } from 'react';
import { joinClasses } from './Layout';
import type { PageTone } from './pageContext';

export interface KeyValueItem {
  /** React key; defaults to the label when it is a string. */
  id?: string;
  label: ReactNode;
  value: ReactNode;
  /** Colours the value. */
  tone?: PageTone;
  /** Mono, tabular value (default true). Set false for prose-like values such as a host name list. */
  mono?: boolean;
  /** Tooltip naming a current cause; never a third line under the value. */
  title?: string;
}

/**
 * Dense label/value rows: label left (11.5 px, subtle), value right (mono
 * 12.5/600). Two or three columns side by side on wide cards, one column at
 * 600 px and below (three drop to two below 1280 px).
 */
export function KeyValueGrid({ items, columns = 2, labels = 'text', className, label }: {
  items: ReadonlyArray<KeyValueItem | null | false | undefined>;
  columns?: 1 | 2 | 3;
  /** 'mono' shows labels as raw keys (e.g. center_freq). */
  labels?: 'text' | 'mono';
  className?: string;
  /** Accessible name of the list. */
  label?: string;
}): JSX.Element {
  const rows = items.filter((item): item is KeyValueItem => Boolean(item));
  return (
    <dl className={joinClasses('pg-kv', `pg-kv-${columns}`, labels === 'mono' && 'has-mono-labels', className)} aria-label={label}>
      {rows.map((item, index) => (
        <div className="pg-kv-row" key={item.id ?? (typeof item.label === 'string' ? item.label : index)} title={item.title}>
          <dt>{item.label}</dt>
          <dd className={joinClasses(item.mono !== false && 'is-mono', item.tone && `is-${item.tone}`) || undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
