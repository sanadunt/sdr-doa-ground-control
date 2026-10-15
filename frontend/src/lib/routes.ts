import type { IconName } from '../components/ui';

export type RouteName = 'overview' | 'receiver' | 'system-health' | 'doa-diagnostics' | 'configuration' | 'message-monitor' | 'simulation';

/**
 * Page order in the menu. A page's shortcut key is its position here (1–7),
 * so the menu, the shortcuts and every "(key)" hint follow this list.
 */
export const ROUTES: ReadonlyArray<{ id: RouteName; icon: IconName }> = [
  { id: 'overview', icon: 'overview' },
  { id: 'receiver', icon: 'receiver' },
  { id: 'system-health', icon: 'health' },
  { id: 'doa-diagnostics', icon: 'diagnostics' },
  { id: 'configuration', icon: 'configuration' },
  { id: 'message-monitor', icon: 'monitor' },
  { id: 'simulation', icon: 'polar' },
];

/** Hash segment written for each page. The Overview route is labelled Dashboard and lives at #/dashboard. */
export const ROUTE_HASH: Readonly<Record<RouteName, string>> = {
  overview: 'dashboard',
  receiver: 'receiver',
  'system-health': 'system-health',
  'doa-diagnostics': 'doa-diagnostics',
  configuration: 'configuration',
  'message-monitor': 'message-monitor',
  simulation: 'simulation',
};

// Older hashes that still open their page: route ids and earlier names.
const HASH_ALIASES: ReadonlyMap<string, RouteName> = new Map<string, RouteName>([
  ...ROUTES.map((route): [string, RouteName] => [route.id, route.id]),
  ['live-doa', 'overview'],
  ['map', 'overview'],
  ['health', 'system-health'],
  ['diagnostics', 'doa-diagnostics'],
  ['settings', 'configuration'],
  ['mqtt', 'message-monitor'],
]);

const ROUTE_BY_HASH: ReadonlyMap<string, RouteName> = new Map(ROUTES.map((route): [string, RouteName] => [ROUTE_HASH[route.id], route.id]));

/** The page a location hash names; anything unknown opens the Dashboard. */
export function routeFromHash(hash: string): RouteName {
  const value = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return ROUTE_BY_HASH.get(value) ?? HASH_ALIASES.get(value) ?? 'overview';
}

/** The hash navigate() writes for a page, e.g. "#/dashboard". */
export function routeHash(route: RouteName): string {
  return `#/${ROUTE_HASH[route]}`;
}

/** The shortcut key of a page: its 1-based position in ROUTES. */
export function routeShortcut(route: RouteName): string {
  return String(ROUTES.findIndex((item) => item.id === route) + 1);
}
