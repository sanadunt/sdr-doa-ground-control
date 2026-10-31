/**
 * True for a host that stays on this machine: localhost, 127.0.0.0/8 or ::1
 * (also in brackets).
 */
export function isLoopbackHost(input: string): boolean {
  const host = input.trim().toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  return Boolean(octets && Number(octets[1]) === 127 && octets.slice(2).every((part) => Number(part) <= 255));
}

/**
 * Which listener served this page. The console's own listener binds loopback
 * only; the opt-in LAN view (`lan_access` on the console, a second listener)
 * serves the same build to allowed LAN clients, read only, and answers
 * `access: "lan-view"` in /api/capabilities.
 *
 * In the LAN view nothing is written but a marker command for the
 * groundstation Receiver (POST /api/mirror/receiver/markers): no admin
 * unlock, no Kontrol, a read-only Configuration page, preferences kept in
 * this browser, and no Receiver frame (the HackRF is on the groundstation's USB).
 */
export type ConsoleAccess = 'local' | 'lan-view';

export const CONSOLE_ACCESS_VALUES: readonly ConsoleAccess[] = ['local', 'lan-view'];

export function isConsoleAccess(value: unknown): value is ConsoleAccess {
  return typeof value === 'string' && (CONSOLE_ACCESS_VALUES as readonly string[]).includes(value);
}

/**
 * Before capabilities arrive: a page loaded from a named host that is not
 * loopback is the LAN view; a loopback host, or none known, is the console's own.
 */
export function accessFromHostname(hostname: string): ConsoleAccess {
  return hostname.trim() !== '' && !isLoopbackHost(hostname) ? 'lan-view' : 'local';
}

/** The server's answer when it has one, otherwise the guess from the page's host. */
export function consoleAccess(reported: ConsoleAccess | null | undefined, hostname: string): ConsoleAccess {
  return reported ?? accessFromHostname(hostname);
}

export function pageHostname(): string {
  try {
    const hostname: unknown = typeof window !== 'undefined' ? window.location?.hostname : undefined;
    return typeof hostname === 'string' ? hostname : '';
  } catch {
    return '';
  }
}
