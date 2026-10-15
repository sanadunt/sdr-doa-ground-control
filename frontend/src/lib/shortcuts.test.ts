import { describe, expect, it } from 'vitest';
import { isTextEntryTarget, shortcutAction } from './shortcuts';
import type { ShortcutKeyEvent } from './shortcuts';

// Duck-typed elements, as an element of the Receiver frame would look to the console window.
function element(tagName: string, attributes: Record<string, string> = {}, extra: Record<string, unknown> = {}): EventTarget {
  return {
    nodeType: 1,
    tagName,
    getAttribute: (name: string) => attributes[name] ?? null,
    ...extra,
  } as unknown as EventTarget;
}

function key(value: string, target: EventTarget | null = null, overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key: value, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, target, ...overrides };
}

describe('console shortcuts', () => {
  it('switch pages and refresh outside text fields', () => {
    expect(shortcutAction(key('1'), 7)).toEqual({ type: 'route', index: 0 });
    expect(shortcutAction(key('7'), 7)).toEqual({ type: 'route', index: 6 });
    expect(shortcutAction(key('8'), 7)).toBeNull();
    expect(shortcutAction(key('0'), 7)).toBeNull();
    expect(shortcutAction(key('r'), 7)).toEqual({ type: 'refresh' });
    expect(shortcutAction(key('R'), 7)).toEqual({ type: 'refresh' });
    expect(shortcutAction(key('x'), 7)).toBeNull();
  });

  it('keep working after a checkbox, radio or button was clicked', () => {
    for (const type of ['checkbox', 'radio', 'button', 'color']) {
      expect(shortcutAction(key('2', element('INPUT', { type }, { type })), 7), type).toEqual({ type: 'route', index: 1 });
    }
    expect(shortcutAction(key('2', element('BUTTON')), 7)).toEqual({ type: 'route', index: 1 });
  });

  it('never fire while typing into a field', () => {
    for (const type of ['text', 'number', 'search', 'url', 'password', '']) {
      expect(shortcutAction(key('2', element('INPUT', { type }, { type })), 7), type || 'no type').toBeNull();
    }
    expect(shortcutAction(key('r', element('TEXTAREA')), 7)).toBeNull();
    expect(shortcutAction(key('1', element('SELECT')), 7)).toBeNull();
    expect(shortcutAction(key('1', element('DIV', {}, { isContentEditable: true })), 7)).toBeNull();
    expect(shortcutAction(key('1', element('DIV', { role: 'textbox' })), 7)).toBeNull();
  });

  it('never fire while a range slider has focus, so a digit does not leave the dashboard', () => {
    expect(shortcutAction(key('3', element('INPUT', { type: 'range' }, { type: 'range' })), 7)).toBeNull();
    expect(shortcutAction(key('r', element('INPUT', { type: 'range' })), 7)).toBeNull();
    expect(isTextEntryTarget(element('INPUT', { type: 'RANGE' }, { type: 'RANGE' }))).toBe(true);
  });

  it('never fire with a modifier or after another handler took the key', () => {
    expect(shortcutAction(key('1', null, { ctrlKey: true }), 7)).toBeNull();
    expect(shortcutAction(key('1', null, { altKey: true }), 7)).toBeNull();
    expect(shortcutAction(key('r', null, { metaKey: true }), 7)).toBeNull();
    expect(shortcutAction(key('1', null, { defaultPrevented: true }), 7)).toBeNull();
  });

  it('treat non-element targets such as the window as no field', () => {
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget({} as EventTarget)).toBe(false);
  });
});
