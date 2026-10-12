import { describe, expect, it } from 'vitest';
import { receiverFrameSrc } from './ReceiverPage';

describe('receiverFrameSrc', () => {
  it('passes the console theme and language to the embedded Receiver', () => {
    expect(receiverFrameSrc('light', 'id')).toBe('/receiver/?theme=light&lang=id');
    expect(receiverFrameSrc('dark', 'en')).toBe('/receiver/?theme=dark&lang=en');
  });
});
