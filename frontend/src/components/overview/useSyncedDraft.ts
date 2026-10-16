import { useEffect, useState } from 'react';

/**
 * Keep a typed draft while it still parses to the stored value; otherwise
 * follow the stored value (Reset, slider, another control, the Receiver).
 * `parse` and `format` must be pure module-level helpers.
 */
export function useSyncedDraft(value: number | null, parse: (text: string) => number | null, format: (value: number) => string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(() => (value === null ? '' : format(value)));
  useEffect(() => {
    setDraft((current) => {
      if (value === null) return current;
      const parsed = parse(current);
      return parsed !== null && Math.abs(parsed - value) < 1e-9 ? current : format(value);
    });
    // parse and format are pure module-level helpers.
  }, [value]);
  return [draft, setDraft];
}
