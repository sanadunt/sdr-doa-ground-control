import { Children, cloneElement, isValidElement, useId, useRef } from 'react';
import type { JSX, ReactElement, ReactNode } from 'react';
import { joinClasses } from './Layout';

type ControlProps = { 'aria-invalid'?: boolean | 'true' | 'false'; 'aria-describedby'?: string; id?: string };

/**
 * A labelled 44 px control with the unit inside the field and an error line
 * only when there is an error. Pass one <input> or <select> as the child; it
 * gets aria-invalid and aria-describedby from `error`. No help text: range
 * hints go into the placeholder or the unit slot.
 */
export function FormField({ label, unit, error, size, mono = false, className, children }: {
  label: ReactNode;
  /** Unit or range shown inside the field on the right ("Hz", "°", "dB"). */
  unit?: ReactNode;
  /** Field-specific error; shown under the field and marks the control invalid. */
  error?: ReactNode;
  /** Fixed width: xs 96 px, sm 160 px, md 240 px; default fills its cell. */
  size?: 'xs' | 'sm' | 'md';
  /** Mono value text (URLs, hosts, paths). Number inputs are always mono. */
  mono?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const errorId = useId();
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const only = Children.count(children) === 1 ? Children.only(children) : null;
  const control = isValidElement<ControlProps>(only)
    ? cloneElement(only as ReactElement<ControlProps>, {
      'aria-invalid': hasError ? true : only.props['aria-invalid'],
      'aria-describedby': joinClasses(only.props['aria-describedby'], hasError && errorId) || undefined,
    })
    : children;
  return (
    <label className={joinClasses('pg-field', size && `is-${size}`, className)}>
      <span className="pg-field-label">{label}</span>
      <span className={joinClasses('pg-control', mono && 'is-mono', hasError && 'is-error')}>
        {control}
        {unit !== undefined && unit !== null && unit !== '' ? <span className="pg-unit">{unit}</span> : null}
      </span>
      {hasError ? <span className="pg-field-error" id={errorId} role="alert">{error}</span> : null}
    </label>
  );
}

/** Grid of FormFields: auto-fill columns of at least 180 px, 10 px × 12 px gaps. Use `row` for a wrapping flex row of sized fields. */
export function FormGrid({ row = false, className, children }: { row?: boolean; className?: string; children: ReactNode }): JSX.Element {
  return <div className={joinClasses(row ? 'pg-form-row' : 'pg-form', className)}>{children}</div>;
}

/**
 * A styled file picker: an ov-button that opens the hidden native input and
 * the chosen file name in mono, so the browser's own "Choose File / No file
 * chosen" text (in the browser's language) never shows.
 */
export function FileButton({ label, accept, fileName, placeholder, disabled = false, onChange, className }: {
  label: ReactNode;
  accept?: string;
  /** Name of the chosen file; `placeholder` shows while none is chosen. */
  fileName?: string | null;
  placeholder?: ReactNode;
  disabled?: boolean;
  /** Receives the native input, as ConfigurationPage's chooseLogo expects. */
  onChange: (input: HTMLInputElement) => void;
  className?: string;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <span className={joinClasses('pg-file', className)}>
      <button className="ov-button" type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>{label}</button>
      <span className="pg-file-name">{fileName || placeholder || null}</span>
      <input ref={inputRef} className="pg-file-input" type="file" accept={accept} tabIndex={-1} aria-hidden="true" disabled={disabled} onChange={(event) => onChange(event.currentTarget)} />
    </span>
  );
}
