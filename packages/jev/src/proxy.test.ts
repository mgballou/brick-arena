import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askForDecision, createBoard } from '../../engine/src/index';
import { CAP_DEFAULTS, capFromEnv, createCap } from './cap';
import { linkFromEnv } from './key';
import { askUpstream, checkHealth, jevMiddleware, type ProxyOptions } from './proxy';
import { startStandIn } from './stand-in-server';
import { httpTransport, readRecording, recordingTransport } from './transport';
import { answeredBy, DOWN_STATUS, refusal, toRequest } from './wire';

// Every call here goes to the local stand-in or to a port nothing listens on.
// None reaches live Jev, and no key but this dummy one is read.
const link = (baseUrl: string) => ({ baseUrl, model: 'jev-test', key: 'test-key-not-real' });
const options = (baseUrl: string, debug: boolean): ProxyOptions => ({ link: link(baseUrl), keyFrom: '/nowhere/.jev-key', debug, timeoutMs: 2000, log: () => {} });

let standIn: { url: string; close: () => Promise<void> };
let deadPort: string;

beforeAll(async () => {
  standIn = await startStandIn({ port: 0, ms: 5 });
  // Take a free port and let it go, so nothing answers there.
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  deadPort = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise(done => probe.close(done));
});
afterAll(() => standIn.close());

describe('who answered', () => {
  it('reads the stand-in from its reply and treats an unmarked reply as live Jev', () => {
    expect(answeredBy({ answered_by: 'stand-in' })).toBe('stand-in');
    expect(answeredBy({})).toBe('live');
  });

  it('lets the stand-in play only in debug mode', () => {
    expect(refusal('live', false)).toBeNull();
    expect(refusal('stand-in', true)).toBeNull();
    expect(refusal('stand-in', false)).toMatch(/stand-in answered, not Jev.*VITE_DEBUG=1/);
  });

  it('marks every stand-in reply, and a call recording keeps the mark', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jev-rec-')), 'calls.ndjson');
    const transport = recordingTransport(httpTransport({ baseUrl: standIn.url, apiKey: 'test-key-not-real' }), path);
    const response = await transport(toRequest(askForDecision(createBoard(3, 0)), 'jev-test'));
    expect(response.answered_by).toBe('stand-in');
    expect(readRecording(path)[0].answeredBy).toBe('stand-in');
    expect(readFileSync(path, 'utf8')).not.toContain('test-key-not-real');
  });
});

describe('the check before a match', () => {
  it('refuses the stand-in outside debug mode and says why', async () => {
    const health = await checkHealth(options(standIn.url, false));
    expect(health).toMatchObject({ ok: false, answeredBy: 'stand-in' });
    expect(!health.ok && health.offline).toMatch(/stand-in answered, not Jev/);
  });

  it('admits the stand-in in debug mode and names it', async () => {
    expect(await checkHealth(options(standIn.url, true))).toMatchObject({ ok: true, answeredBy: 'stand-in' });
  });

  it('says Jev could not be reached when nothing listens', async () => {
    expect(await checkHealth(options(deadPort, true))).toEqual({ ok: false, offline: 'Jev could not be reached: ECONNREFUSED' });
  });

  it('says there is no key when the key file is empty', async () => {
    expect(await checkHealth({ ...options(standIn.url, true), link: { ...link(standIn.url), key: '' } })).toEqual({ ok: false, offline: 'No key in /nowhere/.jev-key.' });
  });
});

describe('the /api/jev route', () => {
  async function serve(proxy: ProxyOptions): Promise<{ url: string; server: Server }> {
    const server = createServer(jevMiddleware(proxy));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
  }
  const ask = () => JSON.stringify(toRequest(askForDecision(createBoard(3, 0)), 'jev'));

  it('refuses a stand-in answer mid-match outside debug mode', async () => {
    const { url, server } = await serve(options(standIn.url, false));
    const response = await fetch(url, { method: 'POST', body: ask() });
    expect(response.status).toBe(DOWN_STATUS);
    expect(await response.json()).toEqual({ ok: false, down: 'unreachable', answeredBy: 'stand-in' });
    server.close();
  });

  it('forwards a stand-in answer, still marked, in debug mode', async () => {
    const { url, server } = await serve(options(standIn.url, true));
    const response = await fetch(url, { method: 'POST', body: ask() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answers: { decision: { type: 'choice', choice: 'aim' } }, answered_by: 'stand-in' });
    server.close();
  });

  it('reports a dead endpoint on the health route', async () => {
    const { url, server } = await serve(options(deadPort, false));
    expect(await (await fetch(url)).json()).toEqual({ ok: false, down: 'unreachable' });
    server.close();
  });

  it('never sends the key back to the browser', async () => {
    const { url, server } = await serve(options(standIn.url, false));
    const bodies = [await (await fetch(url)).text(), await (await fetch(url, { method: 'POST', body: ask() })).text()];
    for (const body of bodies) expect(body).not.toContain('test-key-not-real');
    server.close();
  });
});

describe('askUpstream', () => {
  it('names a reply that is not JSON', async () => {
    const server = createServer((_, res) => res.end('<html>'));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const outcome = await askUpstream(options(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, true), {});
    expect(outcome).toEqual({ ok: false, offline: 'Jev answered with something that is not JSON.' });
    server.close();
  });
});

// A fake TypeSafe that fails the way the real one can. Nothing here is Jev.
describe('when TypeSafe fails', () => {
  type Reply = { status: number; body: string } | 'hang';
  async function fakeUpstream(reply: Reply) {
    const server = createServer((req, res) => {
      req.resume();
      if (reply === 'hang') return;
      res.statusCode = reply.status;
      res.setHeader('content-type', 'application/json');
      res.end(reply.body);
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.closeAllConnections(); server.close(); } };
  }
  async function forward(reply: Reply, method: 'GET' | 'POST') {
    const upstream = await fakeUpstream(reply);
    const logged: string[] = [];
    const server = createServer(jevMiddleware({ ...options(upstream.url, false), timeoutMs: 150, log: line => logged.push(line) }));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(url, method === 'POST' ? { method, body: JSON.stringify(toRequest(askForDecision(createBoard(3, 0)), 'jev')) } : {});
    const text = await response.text();
    server.close();
    upstream.close();
    return { status: response.status, text, logged };
  }

  const failures: Array<[string, Reply, RegExp]> = [
    ['an auth refusal (401)', { status: 401, body: '{"error_type":"authentication_error","message":"Invalid API key sk-upstream-detail"}' }, /401.*Invalid API key/],
    ['a credit refusal (402)', { status: 402, body: '{"error_type":"payment_required","message":"Out of credits upstream-detail"}' }, /402.*Out of credits/],
    ['a quota body', { status: 403, body: '{"error_type":"insufficient_quota","message":"Monthly quota exhausted upstream-detail"}' }, /403.*quota exhausted/],
    ['a rate limit (429)', { status: 429, body: '{"error_type":"rate_limit_error","message":"Slow down upstream-detail"}' }, /429.*Slow down/],
    ['a server error (500)', { status: 500, body: '{"error_type":"api_error","message":"Internal upstream-detail"}' }, /500.*Internal/],
    ['a timeout', 'hang', /did not answer in 150 ms/],
  ];
  for (const [name, reply, detail] of failures) {
    for (const method of ['POST', 'GET'] as const) {
      it(`maps ${name} to the down status on ${method}, and keeps the detail in the log`, async () => {
        const { status, text, logged } = await forward(reply, method);
        expect(status).toBe(DOWN_STATUS);
        expect(JSON.parse(text)).toEqual({ ok: false, down: 'unreachable' });
        expect(text).not.toContain('upstream-detail');
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatch(detail);
        expect(logged[0]).not.toContain('test-key-not-real');
      });
    }
  }
});

describe('the daily cap', () => {
  const ask = () => JSON.stringify(toRequest(askForDecision(createBoard(3, 0)), 'jev'));
  async function serve(proxy: ProxyOptions) {
    const server = createServer(jevMiddleware(proxy));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }
  const as = (visitor: string) => ({ method: 'POST', body: ask(), headers: { 'x-forwarded-for': `${visitor}, 10.0.0.1` } });

  it('counts calls per visitor and sends the down status past the limit', async () => {
    const logged: string[] = [];
    const { url, close } = await serve({ ...options(standIn.url, true), cap: createCap({ perVisitor: 2, total: 100 }), log: line => logged.push(line) });
    expect((await fetch(url, as('1.1.1.1'))).status).toBe(200);
    expect((await fetch(url, as('1.1.1.1'))).status).toBe(200);
    const refused = await fetch(url, as('1.1.1.1'));
    expect(refused.status).toBe(DOWN_STATUS);
    expect(await refused.json()).toEqual({ ok: false, down: 'used-up' });
    expect(logged).toEqual(['down (used-up): a visitor reached 2 calls today']);
    expect((await fetch(url, as('2.2.2.2'))).status).toBe(200);
    close();
  });

  it('holds a total for the day across visitors, the health check included', async () => {
    const { url, close } = await serve({ ...options(standIn.url, true), cap: createCap({ perVisitor: 100, total: 2 }) });
    expect((await fetch(url, { headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(200);
    expect((await fetch(url, as('4.4.4.4'))).status).toBe(200);
    for (const response of [await fetch(url, as('5.5.5.5')), await fetch(url, { headers: { 'x-forwarded-for': '6.6.6.6' } })]) {
      expect(response.status).toBe(DOWN_STATUS);
      expect(await response.json()).toEqual({ ok: false, down: 'used-up' });
    }
    close();
  });

  it('starts again on a new day', () => {
    let day = '2026-09-25';
    const cap = createCap({ perVisitor: 1, total: 1 }, () => day);
    expect(cap.take('a')).toBe('ok');
    expect(cap.take('b')).toBe('total');
    day = '2026-09-26';
    expect(cap.take('a')).toBe('ok');
  });

  it('reads its limits from the environment, and keeps the defaults otherwise', () => {
    expect(capFromEnv({ JEV_CALLS_PER_VISITOR_PER_DAY: '30', JEV_CALLS_PER_DAY: '300' }).limits).toEqual({ perVisitor: 30, total: 300 });
    expect(capFromEnv({ JEV_CALLS_PER_VISITOR_PER_DAY: 'lots', JEV_CALLS_PER_DAY: '' }).limits).toEqual(CAP_DEFAULTS);
  });
});

describe('the hosted key', () => {
  it('comes from the JEV_API_KEY secret, and its absence leaves the game down', () => {
    expect(linkFromEnv({ JEV_API_KEY: ' test-key-not-real\n' })).toEqual({ baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', key: 'test-key-not-real' });
    expect(linkFromEnv({}).key).toBe('');
  });
});
