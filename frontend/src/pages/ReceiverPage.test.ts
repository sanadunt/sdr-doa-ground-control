import { describe, expect, it } from 'vitest';
import { consoleRequestsMockSdr, forwardFrameShortcut, receiverFrameSrc } from './ReceiverPage';

describe('receiverFrameSrc', () => {
  it('passes the console theme and language to the embedded Receiver', () => {
    expect(receiverFrameSrc('light', 'id')).toBe('/receiver/?theme=light&lang=id');
    expect(receiverFrameSrc('dark', 'en')).toBe('/receiver/?theme=dark&lang=en');
  });

  it('adds mock=1 only when the console asks for the Mock SDR', () => {
    expect(receiverFrameSrc('light', 'id', true)).toBe('/receiver/?theme=light&lang=id&mock=1');
    expect(receiverFrameSrc('light', 'id', false)).toBe('/receiver/?theme=light&lang=id');
  });
});

describe('consoleRequestsMockSdr', () => {
  it('passes ?mock=1 on from a loopback console page', () => {
    expect(consoleRequestsMockSdr({ hostname: '127.0.0.1', search: '?mock=1' })).toBe(true);
    expect(consoleRequestsMockSdr({ hostname: 'localhost', search: '?lang=id&mock=1' })).toBe(true);
    expect(consoleRequestsMockSdr({ hostname: '[::1]', search: '?mock=1' })).toBe(true);
  });

  it('keeps the Mock SDR off without the flag or away from loopback', () => {
    expect(consoleRequestsMockSdr({ hostname: '127.0.0.1', search: '' })).toBe(false);
    expect(consoleRequestsMockSdr({ hostname: '127.0.0.1', search: '?mock=0' })).toBe(false);
    expect(consoleRequestsMockSdr({ hostname: '127.0.0.1', search: '?mock=true' })).toBe(false);
    expect(consoleRequestsMockSdr({ hostname: 'console.example', search: '?mock=1' })).toBe(false);
    expect(consoleRequestsMockSdr({ hostname: '192.168.1.20', search: '?mock=1' })).toBe(false);
  });
});

describe('Receiver frame shortcut forwarding', () => {
  class TestKeyboardEvent extends Event {
    key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init as EventInit);
      this.key = String(init.key ?? '');
      this.code = String(init.code ?? '');
      this.altKey = init.altKey === true;
      this.ctrlKey = init.ctrlKey === true;
      this.metaKey = init.metaKey === true;
      this.shiftKey = init.shiftKey === true;
    }
  }
  // An element of the frame document, as the console window sees it.
  class FrameElement extends EventTarget {
    nodeType = 1;
    constructor(public tagName: string, public type = '') { super(); }
    getAttribute(name: string): string | null { return name === 'type' ? this.type : null; }
  }

  function pressInFrame(key: string, target: FrameElement, consoleWindow: EventTarget): { forwarded: boolean; prevented: boolean } {
    const original = globalThis.KeyboardEvent;
    (globalThis as { KeyboardEvent: unknown }).KeyboardEvent = TestKeyboardEvent;
    try {
      let forwarded = false;
      const event = new TestKeyboardEvent('keydown', { key, cancelable: true });
      target.addEventListener('keydown', (inner) => { forwarded = forwardFrameShortcut(inner as KeyboardEvent, consoleWindow as Window); }, { once: true });
      target.dispatchEvent(event);
      return { forwarded, prevented: event.defaultPrevented };
    } finally {
      (globalThis as { KeyboardEvent: unknown }).KeyboardEvent = original;
    }
  }

  it('hands 1-7 and R to the console shell and marks them handled in the frame', () => {
    const consoleWindow = new EventTarget();
    const seen: string[] = [];
    consoleWindow.addEventListener('keydown', (event) => { seen.push((event as TestKeyboardEvent).key); event.preventDefault(); });
    expect(pressInFrame('3', new FrameElement('INPUT', 'checkbox'), consoleWindow)).toEqual({ forwarded: true, prevented: true });
    expect(pressInFrame('r', new FrameElement('BUTTON'), consoleWindow)).toEqual({ forwarded: true, prevented: true });
    expect(seen).toEqual(['3', 'r']);
  });

  it('leaves keys typed into a frame field, and other keys, in the frame', () => {
    const consoleWindow = new EventTarget();
    const seen: string[] = [];
    consoleWindow.addEventListener('keydown', (event) => { seen.push((event as TestKeyboardEvent).key); });
    expect(pressInFrame('2', new FrameElement('INPUT', 'text'), consoleWindow).forwarded).toBe(false);
    expect(pressInFrame('ArrowUp', new FrameElement('BUTTON'), consoleWindow).forwarded).toBe(false);
    expect(seen).toEqual([]);
  });
});
