/**
 * Restart and Shutdown of the groundstation PC from the top bar.
 *
 * The console's own page only (access "local"): POST /api/host/power writes
 * a request file that the host helper (packaging/host-power) acts on with
 * systemctl reboot or poweroff. The LAN view gets neither the buttons nor the
 * capability, and its listener refuses this route (its one POST is a marker command).
 *
 * The constants repeat tools/host_power.py (tools/test_host_power.py
 * compares them); every reason and error code has an EN and ID text.
 */
import type { MessageKey } from './i18n';

export const HOST_POWER_ROUTE = '/api/host/power';
export const HOST_POWER_ACTIONS = ['reboot', 'poweroff'] as const;
export type HostPowerAction = typeof HOST_POWER_ACTIONS[number];
/**
 * Why the buttons are disabled: no directory configured, a container whose
 * compose.yml lacks the mount, none on the host, not writable, or no helper marker.
 */
export const HOST_POWER_REASONS = ['NOT_CONFIGURED', 'DIR_NOT_MOUNTED', 'DIR_MISSING', 'DIR_NOT_WRITABLE', 'HELPER_MISSING'] as const;
export type HostPowerReason = typeof HOST_POWER_REASONS[number];
export const HOST_POWER_ERROR_CODES = [
  'ORIGIN_REJECTED', 'HOST_POWER_INVALID', 'HOST_POWER_TOO_LARGE', 'HOST_POWER_CONFIRM_REQUIRED',
  'HOST_POWER_UNAVAILABLE', 'HOST_POWER_PENDING', 'HOST_POWER_WRITE_FAILED',
] as const;
export type HostPowerErrorCode = typeof HOST_POWER_ERROR_CODES[number];

export interface HostPowerCapability {
  available: boolean;
  /** Set when not available; null for a reason this page does not know. */
  reason: HostPowerReason | null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : null;
}

/** /api/capabilities `host_power`; null when absent (the LAN view, an older console). */
export function normalizeHostPower(value: unknown): HostPowerCapability | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.available !== 'boolean') return null;
  return record.available
    ? { available: true, reason: null }
    : { available: false, reason: oneOf(HOST_POWER_REASONS, record.reason) };
}

/** Whether the Receiver is writing a recording or a scan (GET /api/health `receiver_busy`). */
export type ReceiverBusy = 'checking' | 'busy' | 'idle' | 'unknown';

/**
 * The confirm step: closed, asking (with the Receiver's state), sending,
 * then the answer. Escape and Cancel close it from every step but sending.
 */
export type HostPowerStep =
  | { stage: 'closed' }
  | { stage: 'confirm'; action: HostPowerAction; busy: ReceiverBusy }
  | { stage: 'sending'; action: HostPowerAction; busy: ReceiverBusy }
  | { stage: 'sent'; action: HostPowerAction }
  | { stage: 'failed'; action: HostPowerAction; code: HostPowerErrorCode | null; reason: HostPowerReason | null; message: string };

export type HostPowerEvent =
  | { type: 'open'; action: HostPowerAction }
  | { type: 'health'; busy: Exclude<ReceiverBusy, 'checking'> }
  | { type: 'send' }
  | { type: 'sent' }
  | { type: 'failed'; code: string | null; reason?: unknown; message: string }
  | { type: 'cancel' };

export const HOST_POWER_CLOSED: HostPowerStep = { stage: 'closed' };

export function hostPowerStep(step: HostPowerStep, event: HostPowerEvent): HostPowerStep {
  switch (event.type) {
    case 'open':
      // A request on its way is not replaced by another one.
      return step.stage === 'sending' ? step : { stage: 'confirm', action: event.action, busy: 'checking' };
    case 'health':
      return step.stage === 'confirm' || step.stage === 'sending' ? { ...step, busy: event.busy } : step;
    case 'send':
      // Only from the confirm step, and not before the Receiver's state is known.
      return step.stage === 'confirm' && step.busy !== 'checking' ? { stage: 'sending', action: step.action, busy: step.busy } : step;
    case 'sent':
      return step.stage === 'sending' ? { stage: 'sent', action: step.action } : step;
    case 'failed':
      return step.stage === 'sending'
        ? { stage: 'failed', action: step.action, code: oneOf(HOST_POWER_ERROR_CODES, event.code), reason: oneOf(HOST_POWER_REASONS, event.reason), message: event.message }
        : step;
    case 'cancel':
      return step.stage === 'sending' ? step : HOST_POWER_CLOSED;
    default:
      return step;
  }
}

export function canSend(step: HostPowerStep): boolean {
  return step.stage === 'confirm' && step.busy !== 'checking';
}

export function reasonKey(reason: HostPowerReason | null): MessageKey {
  return reason ? `power.reason.${reason}` as MessageKey : 'power.reason.unknown';
}

export function errorKey(code: HostPowerErrorCode | null): MessageKey | null {
  return code ? `power.error.${code}` as MessageKey : null;
}

/** GET /api/health `receiver_busy`: a Receiver recording or scan archive is being written. */
export async function readReceiverBusy(signal?: AbortSignal): Promise<'busy' | 'idle'> {
  const response = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || typeof (body as Record<string, unknown>).receiver_busy !== 'boolean') {
    throw new Error('health answer has no receiver_busy');
  }
  return (body as Record<string, unknown>).receiver_busy ? 'busy' : 'idle';
}

export class HostPowerError extends Error {
  readonly code: string | null;
  readonly reason: unknown;
  constructor(message: string, code: string | null, reason: unknown) {
    super(message);
    this.name = 'HostPowerError';
    this.code = code;
    this.reason = reason;
  }
}

/** POST /api/host/power with confirm: true; resolves on 202, rejects with the server's code otherwise. */
export async function requestHostPower(action: HostPowerAction, signal?: AbortSignal): Promise<void> {
  const response = await fetch(HOST_POWER_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ action, confirm: true }),
    signal,
  });
  if (response.status === 202) return;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // An answer without JSON keeps only its status.
  }
  const code = typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(body.code) ? body.code : null;
  const message = typeof body.error === 'string' && body.error.length <= 400 ? body.error : `HTTP ${response.status}`;
  throw new HostPowerError(message, code, body.reason);
}
