import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCap } from '../../jev/src/cap';
import { startStandIn } from '../../jev/src/stand-in-server';
import { DOWN_STATUS, JEV_PATH } from '../../jev/src/wire';
import { adminHeader } from './admin';
import { createMatchStore } from './matches';
import { MATCHES_PATH, newMatchId } from './record';
import { hostedApp, hostedFromEnv } from './serve';

// The hosted server over a stand-in dist/ and the local stand-in. Nothing here
// reaches live Jev, and the key is a dummy.
let standIn: { url: string; close: () => Promise<void> };
let server: Server;
let base: string;
const logged: string[] = [];

beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), 'brick-arena-hosted-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'matches.html'), '<!doctype html><main id="matches"></main>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'download.bin'), 'host download');
  writeFileSync(join(dist, '..', 'brick-arena-secret.txt'), 'outside dist');
  standIn = await startStandIn({ port: 0, ms: 5 });
  // Not in debug mode, as hosted: a stand-in's answer is Jev being down.
  server = createServer(hostedApp({ dist, proxy: { link: { baseUrl: standIn.url, model: 'jev-test', key: 'test-key-not-real' }, keyFrom: 'the JEV_API_KEY secret', debug: false, cap: createCap({ perVisitor: 100, total: 100 }), log: line => logged.push(line) }, matches: createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-matches-'))), admin: null }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await standIn.close();
});

describe('the hosted server', () => {
  it('serves the page, and its hashed assets for good', async () => {
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(page.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toContain('id="root"');
    const asset = await fetch(`${base}/assets/index-abc123.js`);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers the host health check without calling Jev', async () => {
    const before = logged.length;
    const health = await fetch(`${base}/healthz`);
    expect(await health.text()).toBe('ok');
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(logged.length).toBe(before);
  });

  it('answers HEAD requests for an asset with its headers and no body', async () => {
    const response = await fetch(`${base}/assets/index-abc123.js`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('');
  });

  it.each(['POST', 'PUT', 'DELETE'])('refuses %s requests to static pages without a body', async method => {
    const response = await fetch(base, { method });
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('');
  });

  it.each(['/bad%escape', '/%E0%A4%A', '/assets/'])('answers malformed paths and directories with an uncached 404: %s', async path => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Not found');
  });

  it('serves files of an unknown type as downloads that must be revalidated', async () => {
    const response = await fetch(`${base}/download.bin`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('host download');
  });

  it('serves nothing outside dist', async () => {
    // fetch folds a bare ../ away, so the escape is spelled inside one segment.
    for (const path of ['/..%2fbrick-arena-secret.txt', '/%2e%2e%2fbrick-arena-secret.txt', '/nope.js']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('has no backstage without ADMIN_SECRET: the records and their page answer 404 to everyone', async () => {
    const id = newMatchId();
    const start = { type: 'start', v: 1, id, at: new Date().toISOString(), seed: 1, tuning: 'standard', opponent: 'live', debug: false };
    expect((await fetch(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', body: JSON.stringify(start) })).status).toBe(200);
    for (const path of [MATCHES_PATH, `${MATCHES_PATH}/${id}`, '/matches.html']) {
      for (const headers of [{}, { authorization: adminHeader('') }, { authorization: adminHeader('anything') }] as Array<Record<string, string>>) {
        const response = await fetch(`${base}${path}`, { headers });
        expect(response.status, path).toBe(404);
        expect(await response.text(), path).not.toContain(id);
      }
    }
  });

  // BUG: authorization checks the encoded path before static serving decodes it.
  it.fails('refuses encoded aliases of the backstage page when no admin is configured', async () => {
    const response = await fetch(`${base}/matches%2ehtml`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('id="matches"');
  });

  it('challenges backstage visitors and serves the page only with the admin password', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'brick-arena-admin-hosted-'));
    writeFileSync(join(dist, 'matches.html'), '<!doctype html><main id="backstage"></main>');
    const adminServer = createServer(hostedApp({ dist, proxy: { link: { baseUrl: standIn.url, model: 'jev-test', key: '' }, keyFrom: 'nowhere', debug: false }, matches: createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-admin-matches-'))), admin: 'test-admin-secret' }));
    await new Promise<void>(done => adminServer.listen(0, '127.0.0.1', done));
    const page = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}/matches.html`;
    try {
      for (const headers of [{}, { authorization: adminHeader('wrong-password') }] as Array<Record<string, string>>) {
        const denied = await fetch(page, { headers });
        expect(denied.status).toBe(401);
        expect(denied.headers.get('www-authenticate')).toBe('Basic realm="Brick Arena backstage", charset="UTF-8"');
        expect(denied.headers.get('cache-control')).toBe('no-store');
        expect(await denied.text()).toBe('Unauthorized');
      }
      const allowed = await fetch(page, { headers: { authorization: adminHeader('test-admin-secret') } });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(allowed.headers.get('cache-control')).toBe('no-cache');
      expect(await allowed.text()).toContain('id="backstage"');
    } finally {
      await new Promise<void>((done, reject) => adminServer.close(error => error ? reject(error) : done()));
    }
  });

  it('mounts the forwarder at the path the browser calls, and never plays the stand-in', async () => {
    const response = await fetch(`${base}${JEV_PATH}`);
    expect(response.status).toBe(DOWN_STATUS);
    expect(await response.json()).toEqual({ ok: false, down: 'unreachable', answeredBy: 'stand-in' });
    expect(logged.at(-1)).toMatch(/stand-in answered, not Jev/);
  });
});

describe('the hosted server at boot', () => {
  it('starts when Supabase does not answer', async () => {
    // A port that was open a moment ago and is closed now: nothing answers.
    const gone = createServer();
    await new Promise<void>(done => gone.listen(0, '127.0.0.1', done));
    const port = (gone.address() as AddressInfo).port;
    await new Promise(done => gone.close(done));
    const env = { SUPABASE_WRITES: '1', SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SECRET_KEY: 'sb_secret_not_real', MATCHES_DIR: mkdtempSync(join(tmpdir(), 'brick-arena-matches-')) };
    const options = await hostedFromEnv(env, mkdtempSync(join(tmpdir(), 'brick-arena-hosted-')));
    expect(options.proxy.cap.take('a')).toBe('ok');
  });
});
