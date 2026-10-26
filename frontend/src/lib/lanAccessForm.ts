import { LAN_ACCESS_ERROR_CODES, LAN_MAX_ALLOWED_CLIENTS, LAN_PORT_MAX, LAN_PORT_MIN } from '../api';
import type { LanAccessErrorCode, LanAccessSettings, LanAccessStatus, LanClosedReason } from '../api';
import type { MessageKey } from './i18n';

/**
 * The Configuration page's "LAN access" card: the draft of the lan_access
 * setting, its checks before a POST, and the labels of the listener's state.
 * The console checks every value again (tools/lan_access.py); the client
 * only catches what it can tell without the server.
 */

export interface LanDraft {
  enabled: boolean;
  port: string;
  bind: string;
  /** Allowed clients as typed: addresses or networks separated by commas, spaces or new lines. */
  clients: string;
}

export type LanDraftField = 'port' | 'bind' | 'clients';

export type LanDraftResult =
  | { ok: true; value: LanAccessSettings }
  | { ok: false; field: LanDraftField; error: MessageKey; vars?: Record<string, string | number> };

/** Entries in typed order, without blanks or repeats. */
export function parseLanClients(text: string): string[] {
  const entries: string[] = [];
  for (const part of text.split(/[\s,;]+/u)) {
    const entry = part.trim();
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

export function formatLanClients(entries: readonly string[]): string {
  return entries.join(', ');
}

export function lanDraftFrom(settings: LanAccessSettings): LanDraft {
  return {
    enabled: settings.enabled,
    port: String(settings.port),
    bind: settings.bind,
    clients: formatLanClients(settings.allowedClients),
  };
}

/** The setting to POST, or the first field the console would refuse for a reason the page can see. */
export function lanSettingsFromDraft(draft: LanDraft, consolePort: number | null): LanDraftResult {
  const portText = draft.port.trim();
  const port = /^[0-9]{1,5}$/u.test(portText) ? Number(portText) : Number.NaN;
  if (!Number.isInteger(port) || port < LAN_PORT_MIN || port > LAN_PORT_MAX) {
    return { ok: false, field: 'port', error: 'config.lanPortInvalid', vars: { min: LAN_PORT_MIN, max: LAN_PORT_MAX } };
  }
  if (consolePort !== null && port === consolePort) {
    return { ok: false, field: 'port', error: 'config.lanPortConsole', vars: { port: consolePort } };
  }
  const bind = draft.bind.trim();
  if (!bind) return { ok: false, field: 'bind', error: 'config.lanBindRequired' };
  const clients = parseLanClients(draft.clients);
  if (clients.length > LAN_MAX_ALLOWED_CLIENTS) {
    return { ok: false, field: 'clients', error: 'config.lanClientsTooMany', vars: { max: LAN_MAX_ALLOWED_CLIENTS } };
  }
  return { ok: true, value: { enabled: draft.enabled, port, bind, allowedClients: clients } };
}

export function sameLanSettings(left: LanAccessSettings, right: LanAccessSettings): boolean {
  return left.enabled === right.enabled
    && left.port === right.port
    && left.bind === right.bind
    && left.allowedClients.length === right.allowedClients.length
    && left.allowedClients.every((entry, index) => entry === right.allowedClients[index]);
}

/** The draft differs from the saved setting (typed separators and order of equal lists aside). */
export function lanDraftDirty(draft: LanDraft, saved: LanAccessSettings): boolean {
  return draft.enabled !== saved.enabled
    || draft.port.trim() !== String(saved.port)
    || draft.bind.trim() !== saved.bind
    || formatLanClients(parseLanClients(draft.clients)) !== formatLanClients(saved.allowedClients);
}

const REASON_KEYS: Record<LanClosedReason, MessageKey> = {
  DISABLED: 'config.lanReason.DISABLED',
  ADMIN_PASSWORD_DEFAULT: 'config.lanReason.ADMIN_PASSWORD_DEFAULT',
  ADMIN_DISABLED: 'config.lanReason.ADMIN_DISABLED',
  PORT_CONFLICT: 'config.lanReason.PORT_CONFLICT',
  BIND_FAILED: 'config.lanReason.BIND_FAILED',
  STOPPED: 'config.lanReason.STOPPED',
};

export function lanReasonKey(reason: LanClosedReason): MessageKey {
  return REASON_KEYS[reason];
}

const ERROR_KEYS: Record<LanAccessErrorCode, MessageKey> = {
  ORIGIN_REJECTED: 'config.lanError.ORIGIN_REJECTED',
  ADMIN_REQUIRED: 'config.lanError.ADMIN_REQUIRED',
  LAN_ACCESS_INVALID: 'config.lanError.LAN_ACCESS_INVALID',
  LAN_ADMIN_PASSWORD_DEFAULT: 'config.lanError.LAN_ADMIN_PASSWORD_DEFAULT',
  LAN_ACCESS_SAVE_FAILED: 'config.lanError.LAN_ACCESS_SAVE_FAILED',
};

/** The message of a POST /api/lan-access error code, or null for a code this page does not know. */
export function lanErrorKey(code: string | null): MessageKey | null {
  return code !== null && (LAN_ACCESS_ERROR_CODES as readonly string[]).includes(code) ? ERROR_KEYS[code as LanAccessErrorCode] : null;
}

/** The card's chip: OPEN, or CLOSED (neutral while switched off, a warning when it should be open). */
export function lanStateChip(status: LanAccessStatus | null): { code: string; tone: 'good' | 'neutral' | 'warn' } {
  if (!status) return { code: 'UNKNOWN', tone: 'neutral' };
  if (status.state === 'open') return { code: 'OPEN', tone: 'good' };
  return { code: 'CLOSED', tone: status.enabled ? 'warn' : 'neutral' };
}
