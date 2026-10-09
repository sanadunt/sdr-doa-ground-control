import { describe, expect, it } from 'vitest';
import { DICTIONARIES, gateReasonLabel, normalizeLang, translate } from './i18n';
import { GATE_REASON_LABELS } from './telemetry';

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('i18n dictionaries', () => {
  it('define the same keys in English and Indonesian', () => {
    expect(Object.keys(DICTIONARIES.id).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
  });

  it('keep every message non-empty with matching placeholders', () => {
    for (const [key, english] of Object.entries(DICTIONARIES.en)) {
      const indonesian = DICTIONARIES.id[key as keyof typeof DICTIONARIES.en];
      expect(english.trim(), key).not.toBe('');
      expect(indonesian.trim(), key).not.toBe('');
      expect(placeholders(indonesian), key).toEqual(placeholders(english));
    }
  });

  it('labels the Monobs and Dashboard routes in both languages', () => {
    expect(translate('en', 'route.receiver' as keyof typeof DICTIONARIES.en)).toBe('Monobs');
    expect(translate('id', 'route.receiver' as keyof typeof DICTIONARIES.en)).toBe('Monobs');
    expect(translate('en', 'route.receiver.hint' as keyof typeof DICTIONARIES.en)).toBe('Spectrum monitoring and recordings');
    expect(translate('id', 'route.receiver.hint' as keyof typeof DICTIONARIES.en)).toBe('Monitoring spektrum dan rekaman');
    expect(translate('en', 'route.overview')).toBe('Dashboard');
    expect(translate('id', 'route.overview')).toBe('Dashboard');
  });

  it('interpolates named values and leaves unknown placeholders intact', () => {
    expect(translate('en', 'shell.lastRead', { age: '3 s' })).toBe('Last read 3 s');
    expect(translate('id', 'shell.lastRead', { age: '3 dtk' })).toBe('Dibaca 3 dtk lalu');
    expect(translate('en', 'shell.lastRead')).toBe('Last read {age}');
  });

  it('accepts only supported languages from storage', () => {
    expect(normalizeLang('id')).toBe('id');
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('fr')).toBe('en');
    expect(normalizeLang(null)).toBe('en');
  });

  it('translates every known gate reason and passes unknown codes through', () => {
    for (const reason of Object.keys(GATE_REASON_LABELS)) {
      expect(gateReasonLabel('id', reason)).not.toBe(GATE_REASON_LABELS[reason]);
      expect(gateReasonLabel('en', reason)).toBe(GATE_REASON_LABELS[reason]);
    }
    expect(gateReasonLabel('id', 'NEW_REASON')).toBe('NEW_REASON');
  });
});
