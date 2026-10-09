import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askForDecision, createBoard } from '../../engine/src/index';
import { ASK_MODEL, DOWN_STATUS, JEV_PATH, STAND_IN_MARK, toRequest } from '../../jev/src/wire';

// The browser's side of the Jev gate: what it sends, and which replies let a
// match start or go on. Each test answers fetch the way the forwarder would.
const reply = (body: unknown, status = 200) => vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const choice = (value: string, extra: object = {}) => ({ answers: { decision: { type: 'choice', choice: value } }, ...extra });

// DEBUG is read when the module loads, so each test loads a fresh copy under
// the VITE_DEBUG it wants.
async function load(debug: '' | '1' = '') {
  vi.stubEnv('VITE_DEBUG', debug);
  vi.resetModules();
  return import('./jev');
}

const ask = () => askForDecision(createBoard(3, 0));

beforeEach(() => vi.stubEnv('VITE_DEBUG', ''));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('askJev', () => {
  it('posts the ask to the game server\'s own route and reads the choice back as a decision', async () => {
    const { askJev } = await load();
    const fetch = reply(choice('aim'));
    vi.stubGlobal('fetch', fetch);
    const question = ask();
    const answer = await askJev(question);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(JEV_PATH);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(JSON.parse(JSON.stringify(toRequest(question, ASK_MODEL))));
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(answer).toMatchObject({ ok: true, choice: 'aim', answeredBy: 'live', decision: { kind: 'target', x: Number(question.options[1]) } });
    expect(answer.ms).toBeGreaterThanOrEqual(0);
  });

  it('puts the key nowhere on the wire: no credential header, no key in the body', async () => {
    const { askJev } = await load();
    const fetch = reply(choice('landing'));
    vi.stubGlobal('fetch', fetch);
    await askJev(ask());
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as object)).toEqual(['content-type']);
    expect(JSON.parse(init.body as string).model).toBe(ASK_MODEL);
  });

  it('gives a deadline that ends a slow reply as a timeout, not as the game being offline', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    expect(await askJev(ask())).toMatchObject({ ok: false, kind: 'timeout', reason: 'No answer in 2000 ms.' });
  });

  it('reports a lost game server as offline', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await askJev(ask())).toMatchObject({ ok: false, kind: 'offline', reason: 'The game server did not answer.' });
  });

  for (const down of ['unreachable', 'used-up'] as const) {
    it(`ends the match on the down page when the forwarder says ${down}`, async () => {
      const { askJev } = await load();
      vi.stubGlobal('fetch', reply({ ok: false, down }, DOWN_STATUS));
      expect(await askJev(ask())).toMatchObject({ ok: false, kind: 'down', down, reason: 'Jev is down.' });
    });
  }

  it('does not read a 503 without a down mark as the down page', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', reply({ ok: false, error: 'Bad gateway.' }, DOWN_STATUS));
    expect(await askJev(ask())).toMatchObject({ ok: false, kind: 'offline', reason: 'Bad gateway.' });
  });

  it('pauses on the server\'s own words when it refuses an ask', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', reply({ ok: false, error: 'That ask was not JSON.' }, 400));
    expect(await askJev(ask())).toMatchObject({ ok: false, kind: 'offline', reason: 'That ask was not JSON.' });
  });

  it('names the status when a failed reply says nothing else', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 500 })));
    expect(await askJev(ask())).toMatchObject({ ok: false, kind: 'offline', reason: 'The game server answered 500.' });
  });

  it('calls a reply that is not JSON a bad answer, not a crash', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await askJev(ask())).toMatchObject({ ok: false, kind: 'bad-answer', reason: expect.stringContaining('not a choice') });
  });

  it('calls a choice outside the offered set a bad answer and names the set', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', reply(choice('sideways')));
    const answer = await askJev(ask());
    expect(answer).toMatchObject({ ok: false, kind: 'bad-answer' });
    expect(answer.ok === false && answer.reason).toContain('Jev chose "sideways"');
    expect(answer.ok === false && answer.reason).toContain('landing');
  });

  it('refuses a stand-in answer outside debug mode, even when the server passed it', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', reply(choice('landing', STAND_IN_MARK)));
    const answer = await askJev(ask());
    expect(answer).toMatchObject({ ok: false, kind: 'offline', reason: expect.stringContaining('VITE_DEBUG=1') });
  });

  it('lets a stand-in answer play in debug mode and says who answered', async () => {
    const { askJev, DEBUG } = await load('1');
    expect(DEBUG).toBe(true);
    vi.stubGlobal('fetch', reply(choice('landing', STAND_IN_MARK)));
    expect(await askJev(ask())).toMatchObject({ ok: true, choice: 'landing', answeredBy: 'stand-in' });
  });

  it('takes any answer without the stand-in mark as live', async () => {
    const { askJev } = await load();
    vi.stubGlobal('fetch', reply(choice('landing', { answered_by: 'jev' })));
    expect(await askJev(ask())).toMatchObject({ ok: true, answeredBy: 'live' });
  });
});

describe('probeJev', () => {
  it('passes when live Jev answers, with its latency', async () => {
    const { probeJev } = await load();
    const fetch = reply({ ok: true, ms: 712, answeredBy: 'live' });
    vi.stubGlobal('fetch', fetch);
    expect(await probeJev()).toEqual({ ok: true, ms: 712, answeredBy: 'live' });
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(path).toBe(JEV_PATH);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads a bare ok as live with no latency', async () => {
    const { probeJev } = await load();
    vi.stubGlobal('fetch', reply({ ok: true }));
    expect(await probeJev()).toEqual({ ok: true, ms: 0, answeredBy: 'live' });
  });

  it('shows the down page when the forwarder says Jev is down', async () => {
    const { probeJev } = await load();
    vi.stubGlobal('fetch', reply({ ok: false, down: 'used-up' }, DOWN_STATUS));
    expect(await probeJev()).toEqual({ ok: false, reason: 'Jev is down.', down: 'used-up' });
  });

  it('keeps the title screen and gives the server\'s reason when the check fails', async () => {
    const { probeJev } = await load();
    vi.stubGlobal('fetch', reply({ ok: false, error: 'No key is set on this server.' }, 502));
    const probe = await probeJev();
    expect(probe).toEqual({ ok: false, reason: 'No key is set on this server.' });
    expect('down' in probe).toBe(false);
  });

  it('names the status when a failed check says nothing else', async () => {
    const { probeJev } = await load();
    vi.stubGlobal('fetch', reply({ ok: false }, 502));
    expect(await probeJev()).toEqual({ ok: false, reason: 'The game server answered 502.' });
  });

  it('refuses a stand-in outside debug mode, so no match starts on it', async () => {
    const { probeJev } = await load();
    vi.stubGlobal('fetch', reply({ ok: true, ms: 5, answeredBy: 'stand-in' }));
    expect(await probeJev()).toEqual({ ok: false, reason: expect.stringContaining('VITE_DEBUG=1') });
  });

  it('lets a stand-in start a match in debug mode', async () => {
    const { probeJev } = await load('1');
    vi.stubGlobal('fetch', reply({ ok: true, ms: 5, answeredBy: 'stand-in' }));
    expect(await probeJev()).toEqual({ ok: true, ms: 5, answeredBy: 'stand-in' });
  });

  it('says the game server did not answer when fetch fails', async () => {
    const { probeJev } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await probeJev()).toEqual({ ok: false, reason: 'The game server did not answer.' });
  });

  it('says the same when the reply is not JSON', async () => {
    const { probeJev } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })));
    expect(await probeJev()).toEqual({ ok: false, reason: 'The game server did not answer.' });
  });
});
