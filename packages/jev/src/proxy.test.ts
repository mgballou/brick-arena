import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askForDecision, createBoard } from '../../engine/src/index';
import { askUpstream, checkHealth, jevMiddleware, type ProxyOptions } from './proxy';
import { startStandIn } from './stand-in-server';
import { httpTransport, readRecording, recordingTransport } from './transport';
import { answeredBy, refusal, toRequest } from './wire';

// Every call here goes to the local stand-in or to a port nothing listens on.
// None reaches live Jev, and no key but this dummy one is read.
const link = (baseUrl: string) => ({ baseUrl, model: 'jev-test', key: 'test-key-not-real' });
const options = (baseUrl: string, debug: boolean): ProxyOptions => ({ link: link(baseUrl), keyFile: '/nowhere/.jev-key', debug, timeoutMs: 2000 });

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
    expect(await checkHealth(options(deadPort, true))).toEqual({ ok: false, offline: 'Jev could not be reached.' });
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
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, answeredBy: 'stand-in' });
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
    expect(await (await fetch(url)).json()).toEqual({ ok: false, offline: 'Jev could not be reached.' });
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
