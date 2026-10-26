import { ApiError } from '../api';
import type { Notice } from './errorNotice';
import type { FormResult } from './configForm';

/**
 * The Data Out host list (console.json data_out_hosts) and the URL rule:
 * Data Out is read from http://HOST:8081 with HOST in the list. The rules
 * mirror tools/sdr_doa_collector.py (normalize_data_out_host,
 * data_out_url_host); tools/fixtures/data_out_hosts.json pins both, so the
 * form saves exactly what the server keeps and the read-back matches.
 */
export const DATA_OUT_PORT = 8081;
export const DEFAULT_DATA_OUT_HOSTS: readonly string[] = ['doasdr.local', '192.168.100.100', '127.0.0.1', 'localhost'];
export const MAX_DATA_OUT_HOSTS = 16;

/** Error codes the console sends for the Data Out rules (sdr_doa_collector.DATA_OUT_*). */
export const DATA_OUT_ERROR_CODES = [
  'DATA_OUT_HOST_INVALID',
  'DATA_OUT_HOSTS_EMPTY',
  'DATA_OUT_HOSTS_TOO_MANY',
  'DATA_OUT_HOST_IN_USE',
  'DATA_OUT_URL_NOT_ALLOWED',
] as const;
export type DataOutErrorCode = typeof DATA_OUT_ERROR_CODES[number];

const ASCII_SPACE = /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/gu;
const ASCII = /^[\x00-\x7f]*$/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IPV4 = /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/u;
const IPV6_CHARS = /^[0-9A-Fa-f:]+$/u;
const HEXTET = /^[0-9A-Fa-f]{1,4}$/u;
const DATA_OUT_URL = /^[Hh][Tt][Tt][Pp]:\/\/([^/]*)\/?$/u;

function hextets(part: string): number[] | null {
  if (part === '') return [];
  const values: number[] = [];
  for (const group of part.split(':')) {
    if (!HEXTET.test(group)) return null;
    values.push(parseInt(group, 16));
  }
  return values;
}

/** The eight groups of an IPv6 address in plain hex notation, or null. */
function parseIpv6(text: string): number[] | null {
  if (!IPV6_CHARS.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = hextets(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = hextets(halves[1]);
  if (!tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** Python's ipaddress compressed form: the first longest run of two or more zero groups becomes "::". */
function compressIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let length = 0;
  groups.forEach((group, index) => {
    if (group === 0) {
      length += 1;
      if (start === -1) start = index;
      if (length > bestLength) {
        bestLength = length;
        bestStart = start;
      }
    } else {
      length = 0;
      start = -1;
    }
  });
  const parts = groups.map((group) => group.toString(16));
  if (bestLength < 2) return parts.join(':');
  const head = parts.slice(0, bestStart).join(':');
  const tail = parts.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

/** An IPv4-mapped IPv6 address (::ffff:0:0/96), which the collector refuses too. */
function isIpv4Mapped(groups: readonly number[]): boolean {
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

/**
 * One host in its saved form, or null: a DNS name (lowercase, one trailing
 * dot removed) or an IPv4/IPv6 address (IPv6 compressed, brackets allowed).
 * No wildcard, scheme, port, path, userinfo, zone id, IPv4-mapped or
 * unspecified address.
 */
export function normalizeDataOutHost(input: string): string | null {
  const text = input.replace(ASCII_SPACE, '');
  if (!text || text.length > 255 || !ASCII.test(text)) return null;
  const bracketed = text.startsWith('[') && text.endsWith(']');
  const candidate = bracketed ? text.slice(1, -1) : text;
  if (candidate.includes(':')) {
    const groups = parseIpv6(candidate);
    if (!groups || groups.every((group) => group === 0) || isIpv4Mapped(groups)) return null;
    return compressIpv6(groups);
  }
  if (bracketed) return null;
  let name = candidate.toLowerCase();
  if (name.endsWith('.')) name = name.slice(0, -1);
  const labels = name.split('.');
  if (/^[0-9]+$/u.test(labels[labels.length - 1])) {
    return IPV4.test(name) && name !== '0.0.0.0' ? name : null;
  }
  if (name.length > 253 || !labels.every((label) => DNS_LABEL.test(label))) return null;
  return name;
}

/** The host of http://HOST[:8081][/] in its saved form, or null for any other URL. */
export function dataOutUrlHost(url: string): string | null {
  if (!url || !ASCII.test(url) || /[\x00-\x20\x7f?#]/u.test(url)) return null;
  const match = DATA_OUT_URL.exec(url);
  if (!match) return null;
  const netloc = match[1];
  if (netloc.includes('@')) return null;
  let host: string;
  let port: string | null;
  if (netloc.startsWith('[')) {
    const close = netloc.indexOf(']');
    if (close < 0) return null;
    host = netloc.slice(1, close);
    const rest = netloc.slice(close + 1);
    if (!host.includes(':') || (rest && !rest.startsWith(':'))) return null;
    port = rest ? rest.slice(1) : null;
  } else {
    const colon = netloc.indexOf(':');
    host = colon < 0 ? netloc : netloc.slice(0, colon);
    port = colon < 0 ? null : netloc.slice(colon + 1);
  }
  if (port !== null && port !== String(DATA_OUT_PORT)) return null;
  return normalizeDataOutHost(host);
}

/** Add a typed host to the draft list: normalized, not twice, at most MAX_DATA_OUT_HOSTS. */
export function addDataOutHost(hosts: readonly string[], input: string): FormResult<string[]> {
  const host = normalizeDataOutHost(input);
  if (host === null) return { ok: false, error: 'config.dataOutHostInvalid' };
  if (hosts.includes(host)) return { ok: false, error: 'config.dataOutHostDuplicate', vars: { host } };
  if (hosts.length >= MAX_DATA_OUT_HOSTS) return { ok: false, error: 'config.dataOutHostsTooMany', vars: { max: MAX_DATA_OUT_HOSTS } };
  return { ok: true, value: [...hosts, host] };
}

export type DataOutDraftField = 'baseUrl' | 'hosts';
export type DataOutDraftResult =
  | { ok: true; value: { base_url: string; data_out_hosts: string[] } }
  | { ok: false; field: DataOutDraftField; notice: Notice };

/**
 * Check the Data Out URL and host list the way the server will, so a save
 * shows the field to fix before it is sent. `savedBaseUrl` decides which
 * field is wrong when the URL's host is missing from the list: an unchanged
 * URL means the list dropped its host.
 */
export function checkDataOutDraft(baseUrl: string, hosts: readonly string[], savedBaseUrl: string): DataOutDraftResult {
  const url = baseUrl.trim().replace(/\/+$/u, '');
  if (!url) return { ok: false, field: 'baseUrl', notice: { key: 'config.baseUrlRequired' } };
  if (!hosts.length) return { ok: false, field: 'hosts', notice: { key: 'config.dataOutHostsEmpty' } };
  if (hosts.length > MAX_DATA_OUT_HOSTS) return { ok: false, field: 'hosts', notice: { key: 'config.dataOutHostsTooMany', vars: { max: MAX_DATA_OUT_HOSTS } } };
  const urlHost = dataOutUrlHost(url);
  if (urlHost !== null && hosts.includes(urlHost)) return { ok: true, value: { base_url: url, data_out_hosts: [...hosts] } };
  if (urlHost !== null && urlHost === dataOutUrlHost(savedBaseUrl)) {
    return { ok: false, field: 'hosts', notice: { key: 'config.dataOutHostInUse', vars: { host: urlHost } } };
  }
  return { ok: false, field: 'baseUrl', notice: dataOutUrlNotice(hosts) };
}

/** "Use http://<host>:8081 with a host from the list: …" for the given list. */
export function dataOutUrlNotice(hosts: readonly string[]): Notice {
  return { key: 'config.dataOutUrlNotAllowed', vars: { hosts: hosts.join(', '), port: DATA_OUT_PORT } };
}

function isDataOutCode(code: string | null): code is DataOutErrorCode {
  return code !== null && (DATA_OUT_ERROR_CODES as readonly string[]).includes(code);
}

/** The field and translated message of a Data Out error from the console, or null for any other error. */
export function dataOutErrorNotice(error: unknown): { field: DataOutDraftField; notice: Notice } | null {
  if (!(error instanceof ApiError) || !isDataOutCode(error.code)) return null;
  const listed = error.details.data_out_hosts;
  const hosts = Array.isArray(listed) ? listed.filter((host): host is string => typeof host === 'string' && host.length <= 255).slice(0, MAX_DATA_OUT_HOSTS) : [];
  const host = typeof error.details.host === 'string' ? error.details.host.slice(0, 255) : '';
  switch (error.code) {
    case 'DATA_OUT_URL_NOT_ALLOWED':
      return { field: 'baseUrl', notice: dataOutUrlNotice(hosts) };
    case 'DATA_OUT_HOST_IN_USE':
      return { field: 'hosts', notice: { key: 'config.dataOutHostInUse', vars: { host } } };
    case 'DATA_OUT_HOSTS_EMPTY':
      return { field: 'hosts', notice: { key: 'config.dataOutHostsEmpty' } };
    case 'DATA_OUT_HOSTS_TOO_MANY':
      return { field: 'hosts', notice: { key: 'config.dataOutHostsTooMany', vars: { max: MAX_DATA_OUT_HOSTS } } };
    default:
      return { field: 'hosts', notice: { key: 'config.dataOutHostInvalid' } };
  }
}

/** Validate a host list from the console's config answer; anything malformed is an error. */
export function normalizeDataOutHostList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DATA_OUT_HOSTS) {
    throw new Error('console config response has an invalid Data Out host list');
  }
  const hosts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || normalizeDataOutHost(entry) !== entry || hosts.includes(entry)) {
      throw new Error('console config response has an invalid Data Out host list');
    }
    hosts.push(entry);
  }
  return hosts;
}
