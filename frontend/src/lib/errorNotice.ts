import { ApiError, ConfigReadbackError, DEFAULT_API_TIMEOUT_MS } from '../api';
import type { MessageKey, Translate } from './i18n';

/**
 * A message kept as a dictionary key, so it follows a language switch, or as
 * text that arrived from the server or the browser and is shown as received.
 */
export type Notice = { key: MessageKey; vars?: Record<string, string | number> } | { text: string };

export function noticeText(t: Translate, notice: Notice): string {
  return 'key' in notice ? t(notice.key, notice.vars) : notice.text;
}

function timeoutSeconds(error: Error): number {
  const timeoutMs = (error as Error & { timeoutMs?: unknown }).timeoutMs;
  const ms = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_API_TIMEOUT_MS;
  return Math.max(1, Math.round(ms / 1000));
}

/** Describe a failed console request; `fallback` is used when the error carries no text. */
export function errorNotice(error: unknown, fallback: MessageKey): Notice {
  if (!(error instanceof Error)) return { key: fallback };
  if (error.name === 'TimeoutError') return { key: 'app.readError.timedOut', vars: { seconds: timeoutSeconds(error) } };
  if (error instanceof ConfigReadbackError) return { key: 'config.connectionReadbackMismatch' };
  if (error instanceof ApiError && !error.serverMessage) return { key: 'common.requestFailedStatus', vars: { status: error.status } };
  // fetch() rejects with a TypeError when the console server cannot be reached.
  if (error instanceof TypeError) return { key: 'common.consoleUnreachable', vars: { error: error.message || error.name } };
  return error.message ? { text: error.message } : { key: fallback };
}
