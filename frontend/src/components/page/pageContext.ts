import { createContext, useContext } from 'react';
import type { Tone } from '../../types';

/** Tones a page primitive can take: the telemetry tones plus info (blue) and signal (amber DoA/manual colour). */
export type PageTone = Tone | 'info' | 'signal';

/**
 * The top bar's read-age line ("Read 2 s ago"), provided by ConsoleShell on
 * every route but the Dashboard. PageHeader shows it under the page title
 * on phones, where the top-bar title is hidden.
 */
export const PageReadAgeContext = createContext<string | null>(null);

export function usePageReadAge(): string | null {
  return useContext(PageReadAgeContext);
}
