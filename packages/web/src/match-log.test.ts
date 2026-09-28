import { afterEach, describe, expect, it, vi } from 'vitest';
import { Consent } from './consent';
import { MatchLog, sendToServer, whileRecording } from './match-log';

afterEach(() => { vi.unstubAllGlobals(); });

describe('sending a match record', () => {
  // Chrome gives a page 64 KiB of keepalive bodies, counted over its life:
  // measured 26 September, sequential 5 KB keepalive POSTs failed after
  // 65,481 bytes, and in a match the record stopped a minute in, at 104 of
  // 610 calls. Only the closing beacon may spend it.
  it('sends the writes during a match without keepalive', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetch);
    for (const size of [100, 5_000, 59_000]) {
      expect(await sendToServer('20260926-100000-abcdef', 'x'.repeat(size), false)).toBe(true);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) expect(init.keepalive).toBeFalsy();
  });
});

describe('a match record after opting out', () => {
  it('sends nothing more, not even the closing beacon', async () => {
    const consent = new Consent(null, false);
    const send = vi.fn(async () => true);
    const log = new MatchLog({ seed: 1, tuning: 'standard', opponent: 'live', debug: false }, whileRecording(consent, send));
    await log.flush();
    expect(send).toHaveBeenCalledTimes(1);
    consent.optOut();
    log.write({ type: 'level', level: 0, name: 'opening' });
    await log.flush();
    consent.optIn();
    log.write({ type: 'level', level: 1, name: 'second' });
    await log.flush();
    log.end('left', 0, 0);
    await log.flush(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
