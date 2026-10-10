import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jevMiddleware, type ProxyOptions } from './proxy';

const link = (baseUrl: string) => ({ baseUrl, model: 'jev-test', key: 'test-key-not-real' });
const options = (baseUrl: string): ProxyOptions => ({
  link: link(baseUrl),
  keyFrom: '/nowhere/.jev-key',
  debug: true,
  timeoutMs: 2000,
  log: () => {},
});

let upstream: Server;
let upstreamUrl: string;
let upstreamCalls = 0;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    upstreamCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers: { decision: { type: 'choice', choice: 'aim' } }, answered_by: 'stand-in' }));
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(done => upstream.close(() => done()));
});

describe('the /api/jev refusal limits', () => {
  async function serve(): Promise<{ url: string; server: Server }> {
    const server = createServer(jevMiddleware(options(upstreamUrl)));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
  }

  async function expectRefused(
    method: string,
    body: string | undefined,
    expectedStatus: number,
    expectedError: string,
  ): Promise<void> {
    upstreamCalls = 0;
    const { url, server } = await serve();
    try {
      const response = await fetch(url, { method, ...(body === undefined ? {} : { body }) });
      expect(response.status).toBe(expectedStatus);
      const reply = await response.json();
      expect(reply).toMatchObject({ ok: false, error: expectedError });
      expect(upstreamCalls).toBe(0);
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  }

  it('returns 405 for a method other than GET or POST without calling Jev', async () => {
    await expectRefused('PUT', undefined, 405, 'Ask Jev with POST or GET.');
  });

  it('returns 413 for an ask larger than 256 KiB without calling Jev', async () => {
    await expectRefused('POST', 'x'.repeat(256 * 1024 + 1), 413, 'That ask is too large.');
  });

  it('returns 400 for malformed JSON without calling Jev', async () => {
    await expectRefused('POST', '{', 400, 'That ask was not JSON.');
  });

  it('returns 400 for a JSON array without calling Jev', async () => {
    await expectRefused('POST', '[]', 400, 'That ask was not JSON.');
  });
});
