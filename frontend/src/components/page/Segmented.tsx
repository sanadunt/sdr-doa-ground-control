import type { JSX, ReactNode } from 'react';
import { joinClasses } from './Layout';

export interface SegmentedOption<V extends string | number> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * The Dashboard's ov-seg switch: 44 px buttons with aria-pressed in a group.
 * For 2–4 options that fit (GPS source, Compass|Polar, WS|TCP, sdr/v1|RDF v2).
 */
export function Segmented<V extends string | number>({ options, value, onChange, label, disabled = false, compact = false, className }: {
  options: ReadonlyArray<SegmentedOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  /** Content-width buttons instead of equal widths. */
  compact?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div className={joinClasses('ov-seg pg-seg', compact && 'is-compact', className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => { if (option.value !== value) onChange(option.value); }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
