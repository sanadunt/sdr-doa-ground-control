import type { JSX, ReactNode } from 'react';
import { joinClasses } from './Layout';

/** An on/off switch on a 44 px row (32×18 track, accent when on). Replaces raw checkboxes on pages. */
export function Switch({ checked, onChange, label, disabled = false, title, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={joinClasses('pg-switch', className)}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="pg-switch-track" aria-hidden="true"><span className="pg-switch-thumb" /></span>
      <span className="pg-switch-label">{label}</span>
    </button>
  );
}
