import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminHeader } from './admin';
import { MATCHES_PATH, newMatchId } from './record';
import { hostedApp, hostedFromEnv } from './serve';

const servers: Server[] = [];
const originalArgv = [...process.argv];
const directory = (name: string) => mkdtempSync(join(tmpdir(), `brick-arena-boot-${name}-`));
const localEnv = (matches: string) => ({
  MATCHES_DIR: matches,
  SUPABASE_WRITES: '0',
  SUPABASE_URL: '',
  SUPABASE_SECRET_KEY: '',
  JEV_API_KEY: '',
  JEV_BASE_URL: 'http://127.0.0.1:1',
  JEV_MODEL: 'jev-test',
  ADMIN_SECRET: '',
  RENDER_GIT_COMMIT: '',
  JEV_CALLS_PER_VISITOR_PER_DAY: '1',
  JEV_CALLS_PER_DAY: '2',
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
  process.argv = [...originalArgv];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock('node:http');
  vi.resetModules();
});

describe('hosted boot from the environment', () => {
  it('keeps player records locally when Supabase writes are off', async () => {
    const options = await hostedFromEnv({ ...localEnv(directory('matches')), ADMIN_SECRET: 'admin-test-not-real' }, directory('dist'));
    const base = await listen(createServer(hostedApp(options)));
    const id = newMatchId();
    const start = { type: 'start', v: 1, id, at: new Date().toISOString(), seed: 1, tuning: 'standard', opponent: 'live', debug: false };
    const write = await fetch(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', body: JSON.stringify(start) });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ ok: true });
    const read = await fetch(`${base}${MATCHES_PATH}/${id}`, { headers: { authorization: adminHeader('admin-test-not-real') } });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain(id);
    expect(options.rows).toBe(false);
  });

  it('honors the configured visitor cap and keeps the total daily cap across a reboot', async () => {
    const env = localEnv(directory('cap'));
    const dist = directory('dist');
    const first = await hostedFromEnv(env, dist);
    expect(first.proxy.cap.limits).toEqual({ perVisitor: 1, total: 2 });
    expect(first.proxy.cap.take('first-visitor')).toBe('ok');
    expect(first.proxy.cap.take('first-visitor')).toBe('visitor');
    const rebooted = await hostedFromEnv(env, dist);
    expect(rebooted.proxy.cap.take('second-visitor')).toBe('ok');
    expect(rebooted.proxy.cap.take('third-visitor')).toBe('total');
    const rebootedAgain = await hostedFromEnv(env, dist);
    expect(rebootedAgain.proxy.cap.take('fourth-visitor')).toBe('total');
  });

  it.each([
    { name: 'without a Jev key or backstage', key: '', admin: '' },
    { name: 'with a Jev key and local backstage', key: 'jev-test-not-real', admin: 'admin-test-not-real' },
  ])('the CLI starts a real server $name', async ({ key, admin }) => {
    // Reserve an unused port before invoking the same entry point used by pnpm start.
    const reservation = createServer();
    await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>(done => reservation.close(() => done()));
    const env = { ...localEnv(directory('cli-matches')), PORT: String(port), JEV_API_KEY: key, ADMIN_SECRET: admin };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const messages: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(message => messages.push(String(message)));
    vi.spyOn(console, 'error').mockImplementation(message => messages.push(String(message)));

    // Capture the real server only so it can be closed; its listener and requests stay real.
    let started: Server | undefined;
    vi.doMock('node:http', async () => {
      const actual = await vi.importActual<typeof import('node:http')>('node:http');
      return { ...actual, createServer: (...args: Parameters<typeof createServer>) => {
        started = actual.createServer(...args);
        servers.push(started);
        return started;
      } };
    });
    vi.resetModules();
    process.argv[1] = fileURLToPath(new URL('./serve.ts', import.meta.url));
    await import('./serve');
    if (!started) throw new Error('The hosted CLI did not start its HTTP server');
    if (!started.listening) await new Promise<void>((done, fail) => {
      started!.once('listening', done);
      started!.once('error', fail);
    });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.text()).toBe('ok');
    expect(messages).toContain(`[jev] cap: 1 calls per visitor and 2 in all, per UTC day`);
    expect(messages).toContain('[supabase] no rows written to Supabase');
    expect(messages).toContain(`Brick Arena on port ${port}`);
    if (key) expect(messages).toContain('[jev] jev-test at http://127.0.0.1:1, key from the JEV_API_KEY secret');
    else expect(messages).toContain('[jev] no JEV_API_KEY secret, so every visitor sees the down page');
    expect(messages.some(message => message.includes(admin ? 'the admin reads local files with ADMIN_SECRET' : 'no ADMIN_SECRET, so no one reads them'))).toBe(true);
  });
});
