import { describe, expect, it, vi } from 'vitest';
import { Consent, OPT_OUT_KEY, type Store } from './consent';

const memory = (): Store & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, removeItem: key => { items.delete(key); } };
};

describe('the opt-out', () => {
  it('records until the player opts out', () => {
    const consent = new Consent(memory(), false);
    expect(consent.choice).toBe('recording');
    consent.optOut();
    expect(consent.recording).toBe(false);
    expect(consent.choice).toBe('opted-out');
  });

  it('is remembered by the browser, and opting back in forgets it', () => {
    const store = memory();
    new Consent(store, false).optOut();
    expect(store.items.get(OPT_OUT_KEY)).toBe('1');
    const later = new Consent(store, false);
    expect(later.choice).toBe('opted-out');
    later.optIn();
    expect(store.items.has(OPT_OUT_KEY)).toBe(false);
    expect(new Consent(store, false).recording).toBe(true);
  });

  it('holds for the page when the browser refuses to store it', () => {
    const refusing: Store = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    const consent = new Consent(refusing, false);
    expect(consent.recording).toBe(true);
    consent.optOut();
    expect(consent.recording).toBe(false);
  });

  it('tells its listeners, once a change', () => {
    const consent = new Consent(null, false);
    const heard = vi.fn();
    const stop = consent.onChange(heard);
    consent.optOut();
    consent.optOut();
    consent.optIn();
    stop();
    consent.optOut();
    expect(heard.mock.calls).toEqual([[false], [true]]);
  });
});

describe('Do Not Track', () => {
  it('records nothing, and the page cannot opt back in over it', () => {
    const consent = new Consent(memory(), true);
    expect(consent.choice).toBe('dnt');
    consent.optIn();
    expect(consent.recording).toBe(false);
  });
});
