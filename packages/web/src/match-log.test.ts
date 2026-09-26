import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToServer } from './match-log';

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
