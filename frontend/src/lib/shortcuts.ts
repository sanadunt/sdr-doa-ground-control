/** Single-key console shortcuts: 1..N switch pages, R refreshes Data Out. */
export type ShortcutAction = { type: 'route'; index: number } | { type: 'refresh' };

export interface ShortcutKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

// Input types that take typed characters. Checkboxes, radios, ranges, buttons
// and colour pickers do not, so shortcuts keep working after clicking them.
const TEXT_INPUT_TYPES = new Set([
  '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'datetime-local', 'month', 'time', 'week',
]);
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

interface ElementLike {
  nodeType?: unknown;
  tagName?: unknown;
  type?: unknown;
  isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
}

/**
 * Whether a key press belongs to a text-entry control. Duck-typed so it also
 * works for elements of the same-origin Receiver frame, which are not
 * instances of this window's HTMLElement.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as ElementLike | null;
  if (!element || element.nodeType !== 1 || typeof element.tagName !== 'string') return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const attribute = (name: string): string => (typeof element.getAttribute === 'function' ? element.getAttribute(name) ?? '' : '');
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((typeof element.type === 'string' ? element.type : attribute('type')).trim().toLowerCase());
  return TEXT_ROLES.has(attribute('role').trim().toLowerCase());
}

export function shortcutAction(event: ShortcutKeyEvent, routeCount: number): ShortcutAction | null {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextEntryTarget(event.target)) return null;
  if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    return index < routeCount ? { type: 'route', index } : null;
  }
  if (event.key === 'r' || event.key === 'R') return { type: 'refresh' };
  return null;
}
