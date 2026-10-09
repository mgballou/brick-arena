import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyDecision, askForDecision, levelNames } from '../../engine/src/index';
import { ARENA, arenaBoard, arenaStep, bounced, firstServe, levelScore, levelWinner, serveTick, sideStatus } from '../../engine/src/arena';
import { createCap } from '../../jev/src/cap';
import { startStandIn } from '../../jev/src/stand-in-server';
import { fromResponse, JEV_PATH, toRequest, type SystemOneResponse } from '../../jev/src/wire';
import { jevLine, lostLines, MatchLog, sideTotal, type Sender } from '../../web/src/match-log';
import { adminHeader } from './admin';
import { createMatchStore, matchReadSourceFromEnv, type MatchStore } from './matches';
import { MATCHES_PATH, newMatchId, parseRecord, tallyJev, tallyLine, tallyRows, timeline, type MatchLine, type MatchSummary } from './record';
import { hostedApp } from './serve';
import { stubClient } from './supabase';

// The hosted server over the local stand-in, in debug mode so the stand-in may
// play, with its match store in a temporary directory. Nothing reaches live Jev.
let standIn: { url: string; close: () => Promise<void> };
let server: Server;
let base: string;
let store: MatchStore;
const ADMIN = 'test-admin-secret-not-real';

beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), 'brick-arena-hosted-'));
  writeFileSync(join(dist, 'matches.html'), '<!doctype html><main id="matches"></main>');
  store = createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-matches-')));
  standIn = await startStandIn({ port: 0, ms: 1 });
  server = createServer(hostedApp({ dist, proxy: { link: { baseUrl: standIn.url, model: 'jev-test', key: 'test-key-not-real' }, keyFrom: 'a test', debug: true, cap: createCap({ perVisitor: 10_000, total: 10_000 }), log: () => {} }, matches: store, admin: ADMIN }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await standIn.close();
});

const toServer: Sender = async (id, body) => (await fetch(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', body })).ok;
// Every read is the admin's, as the backstage page and `pnpm match --from` make it.
const read = (path: string, secret = ADMIN) => fetch(`${base}${path}`, { headers: { authorization: adminHeader(secret) } });
const post = (id: string, lines: unknown[]) => fetch(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', body: lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') });
const start = (id: string) => ({ type: 'start', v: 1, id, at: new Date().toISOString(), seed: 1, tuning: 'standard', opponent: 'stand-in', debug: true });

// One level of the web game, scripted the way main.tsx plays it: the shared
// countdown, then your paddle held still and served at once after each lost
// ball, and Jev's board asked through the hosted server on the game's cadence.
async function scriptedMatch(frames: number): Promise<string> {
  const log = new MatchLog({ seed: 20260919, tuning: 'standard', opponent: 'stand-in', debug: true }, toServer);
  const level = 0;
  const sides = { human: { state: arenaBoard(20260919, level), serve: firstServe(), serving: true, clearedAt: null as number | null }, jev: { state: arenaBoard(20260919, level), serve: firstServe(), serving: true, clearedAt: null as number | null } };
  log.write({ type: 'level', level, name: levelNames[level] });
  let countdown = ARENA.countdownTicks, frame = 0;
  const score = (who: 'human' | 'jev') => levelScore(sides[who].state, sides[who].clearedAt);
  while (frame < frames) {
    if (countdown > 0) countdown--; else frame++;
    for (const who of ['human', 'jev'] as const) {
      const side = sides[who];
      if (sideStatus(side.state) !== 'playing') continue;
      if (side.serving) {
        const served = serveTick(side.state, side.serve, { who, countdown, pressed: true });
        if (served.launched) log.write({ type: 'launch', level, frame, side: who, x: Math.round(served.state.balls[0].x), first: side.serve.first });
        side.state = served.state; side.serve = served.serve; side.serving = !served.launched;
        continue;
      }
      const before = side.state;
      const { state, events } = arenaStep(before);
      side.state = state;
      for (const line of lostLines({ level, frame, side: who }, events.ballsLost, events.lifeLost, state)) log.write(line);
      if (events.lifeLost) side.serving = true;
      if (state.completed && side.clearedAt === null) side.clearedAt = frame;
      if (who === 'jev' && !side.serving && !state.completed && (bounced(before, state) || state.tick % ARENA.askEvery === 0)) {
        const ask = askForDecision(state);
        const started = Date.now();
        const reply = await (await fetch(`${base}${JEV_PATH}`, { method: 'POST', body: JSON.stringify(toRequest(ask, 'jev')) })).json() as SystemOneResponse;
        side.state = applyDecision(side.state, fromResponse(ask, reply));
        log.write(jevLine({ level, frame, tick: state.tick, lead: 0 }, ask, 'answered', Date.now() - started, String((reply.answers.decision as { choice: string }).choice)));
      }
    }
    if (countdown === 0 && frame > 0 && frame % ARENA.ticksPerSecond === 0) log.write({ type: 'progress', level, frame, human: sideTotal(sides.human.state, score('human')), jev: sideTotal(sides.jev.state, score('jev')) });
    if (frame % 300 === 0) await log.flush();
  }
  const side = (who: 'human' | 'jev') => ({ status: sideStatus(sides[who].state), clearedAt: sides[who].clearedAt, levelScore: score(who) });
  log.write({ type: 'levelEnd', level, frame, winner: levelWinner(side('human'), side('jev')), human: { ...sideTotal(sides.human.state, score('human')), cleared: false }, jev: { ...sideTotal(sides.jev.state, score('jev')), cleared: false } });
  log.end('final', score('human'), score('jev'));
  await log.flush();
  return log.id;
}

describe('a match record', () => {
  it('is written as a scripted match plays, and the reader prints it', async () => {
    const id = await scriptedMatch(40 * ARENA.ticksPerSecond);
    const lines = parseRecord(await (await read(`${MATCHES_PATH}/${id}`)).text());
    const types = lines.map(line => line.type);
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('end');
    for (const type of ['level', 'launch', 'lost', 'progress', 'jev', 'levelEnd'] as const) expect(types, type).toContain(type);

    const launches = lines.filter(line => line.type === 'launch');
    expect(launches.filter(line => line.first).map(line => line.side).sort()).toEqual(['human', 'jev']);
    const lost = lines.find(line => line.type === 'lost' && line.side === 'human');
    expect(lost).toMatchObject({ lifeLost: true, livesLeft: expect.any(Number) });
    const call = lines.find((line): line is Extract<MatchLine, { type: 'jev' }> => line.type === 'jev')!;
    expect(call.outcome).toBe('answered');
    expect(call.choice).toEqual(expect.any(String));
    expect(call.options.length).toBeGreaterThan(0);
    expect(call.state.bricks).toMatch(/^[0-9#]+$/);
    expect(call.state).toHaveProperty('balls');

    // What `pnpm match <id>` prints, from the same directory the server writes.
    const printed = timeline(lines);
    expect(printed[0]).toContain(`Match ${id}`);
    expect(printed.some(row => /You launched at x=\d+ \(the countdown\)/.test(row))).toBe(true);
    expect(printed.some(row => /You lost a ball at x=\d+: \d balls? left/.test(row))).toBe(true);
    expect(printed.some(row => /Stand-in asked target \[.*\]: chose /.test(row))).toBe(true);
    expect(printed.at(-1)).toMatch(/Match over/);
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    // Every call is in the record, in the order it was made, and the tally
    // counts them all: the stand-in aims every catch.
    const calls = lines.filter((line): line is Extract<MatchLine, { type: 'jev' }> => line.type === 'jev');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map(line => line.tick)).toEqual([...calls.map(line => line.tick)].sort((a, b) => a - b));
    const tally = tallyJev(lines);
    expect(tally.calls).toBe(calls.length);
    const catches = calls.filter(line => line.question === 'target');
    expect(tally.target.aim).toBe(catches.length);
    expect(tally.target.landing).toBe(0);
    const cli = execFileSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/cli/src/match.ts'), id], { env: { ...process.env, MATCHES_DIR: store.dir }, encoding: 'utf8' });
    expect(cli.trim().split('\n')).toEqual([...printed, '', ...tallyRows(tally, 'Stand-in')]);
    expect(cli).toContain(`Aimed ${catches.length}, played safe 0`);
    const list = execFileSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/cli/src/match.ts')], { env: { ...process.env, MATCHES_DIR: store.dir }, encoding: 'utf8' });
    expect(list).toMatch(new RegExp(`^${id}  stand-in \\(debug\\), standard  levels: `, 'm'));
    expect(list.split('\n').find(row => row.startsWith(id))).toContain(`stand-in ${tallyLine(tally)}`);

    const listed = await (await read(MATCHES_PATH)).json() as { matches: MatchSummary[] };
    const summary = listed.matches.find(match => match.id === id)!;
    expect(summary.end).toMatchObject({ reason: 'final' });
    expect(summary.ballsLost.human).toBe(lines.filter(line => line.type === 'lost' && line.side === 'human').length);
    expect(summary.jev).toEqual(tally);
  }, 60_000);

  it('shows nothing to anyone but the admin: no list, no record, no page', async () => {
    const id = newMatchId();
    expect((await post(id, [start(id), { type: 'level', level: 0, name: 'x' }])).status).toBe(200);
    const asked = [
      () => fetch(`${base}${MATCHES_PATH}`),
      () => fetch(`${base}${MATCHES_PATH}/${id}`),
      () => fetch(`${base}/matches.html`),
      () => read(MATCHES_PATH, 'wrong-secret'),
      () => read(`${MATCHES_PATH}/${id}`, 'wrong-secret'),
      () => read('/matches.html', 'wrong-secret'),
      () => fetch(`${base}${MATCHES_PATH}/${id}`, { headers: { authorization: `Bearer ${ADMIN}` } }),
      () => fetch(`${base}${MATCHES_PATH}/${id}`, { headers: { authorization: 'Basic !!!' } }),
      () => fetch(`${base}${MATCHES_PATH}/${id}`, { headers: { authorization: `Basic ${Buffer.from('admin-without-password').toString('base64')}` } }),
    ];
    for (const ask of asked) {
      const response = await ask();
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/^Basic /);
      const body = await response.text();
      expect(body).not.toContain(id);
      expect(body).not.toContain('"type"');
    }
    // The game still writes without signing in, and the admin reads it all.
    expect((await read(MATCHES_PATH)).status).toBe(200);
    expect(await (await read(`${MATCHES_PATH}/${id}`)).text()).toContain(id);
    expect(await (await read('/matches.html')).text()).toContain('id="matches"');
  });

  it('opens with start, takes one start, and takes only lines it knows', async () => {
    const id = newMatchId();
    expect((await post(id, [{ type: 'level', level: 0, name: 'x' }])).status).toBe(409);
    expect((await post(id, [start(id)])).status).toBe(200);
    expect((await post(id, [start(id)])).status).toBe(409);
    expect((await post(id, [{ type: 'level', level: 0, name: 'x' }, 'not json'])).status).toBe(400);
    expect((await post(id, [{ type: 'visitor', ip: '1.2.3.4' }])).status).toBe(400);
    expect((await post(newMatchId(), [start('20260101-000000-aaaaaa')])).status).toBe(409);
    expect(parseRecord(store.read(id)!).map(line => line.type)).toEqual(['start']);
  });

  it('reads and writes only files named for a match id', async () => {
    for (const bad of ['..%2f..%2fetc%2fpasswd', 'abc', '20260926-000000-ABCDEF']) {
      expect((await fetch(`${base}${MATCHES_PATH}/${bad}`)).status, bad).toBe(404);
      expect((await post(bad, [start(bad)])).status, bad).toBe(404);
    }
    expect(readdirSync(store.dir).every(name => /^\d{8}-\d{6}-[a-z0-9]{6}\.ndjson$/.test(name))).toBe(true);
  });

  it('takes a new match only if its id names a start near now', async () => {
    const ahead = newMatchId(new Date(Date.now() + 2 * 24 * 3600 * 1000));
    expect((await post(ahead, [start(ahead)])).status).toBe(409);
    expect(store.read(ahead)).toBeNull();
  });

  it('survives a write cut off mid-body', async () => {
    const id = newMatchId();
    const { request } = await import('node:http');
    await new Promise<void>(done => {
      const req = request(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', headers: { 'content-length': '1000' } });
      req.on('error', () => done());
      req.write(JSON.stringify(start(id)).slice(0, 20));
      setTimeout(() => { req.destroy(); done(); }, 50);
    });
    await new Promise(done => setTimeout(done, 50));
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('stops taking lines at its size limits, across matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-small-'));
    const clock = () => Date.parse('2026-09-26T10:30:00Z');
    const small = createMatchStore(dir, { maxTotalBytes: 700, maxMatchBytes: 400 }, clock);
    const a = newMatchId(new Date('2026-09-26T10:00:00Z')), b = newMatchId(new Date('2026-09-26T10:10:00Z')), c = newMatchId(new Date('2026-09-26T10:20:00Z'));
    const level = { type: 'level', level: 0, name: 'x'.repeat(100) } as MatchLine;
    expect(small.append(a, [start(a) as MatchLine])).toBe('ok');
    expect(small.append(a, [level])).toBe('ok');
    expect(small.append(a, [level])).toBe('match-full');
    expect(small.append(b, [start(b) as MatchLine])).toBe('ok');
    // The total binds a match that is already open, not just a new one.
    expect(small.append(b, [level])).toBe('ok');
    expect(small.append(b, [level])).toBe('full');
    expect(small.append(c, [start(c) as MatchLine])).toBe('full');
    // A store opened on the same directory reads the same sizes and summaries.
    const again = createMatchStore(dir, { maxTotalBytes: 700, maxMatchBytes: 400 }, clock);
    expect(again.append(b, [level])).toBe('full');
    expect(again.list().map(match => match.id)).toEqual([b, a]);
    expect(again.list()).toEqual(small.list());
  });

  it('reads the admin list and timeline from the fake Supabase client when configured', async () => {
    const client = stubClient();
    let reads = 0;
    const select = client.select.bind(client);
    client.select = async (table, query) => { reads++; return select(table, query); };
    const id = newMatchId();
    client.tables.matches.push({ id, started_at: new Date().toISOString(), ended_at: null, seed: 7, tuning: 'standard', opponent: 'live', jev_tally: null });
    client.tables.match_events.push({ match_id: id, n: 0, type: 'level', level: 0, frame: null, data: { name: 'First' } });
    const store = createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-fallback-')));
    expect(matchReadSourceFromEnv({}, store)).toBe(store);
    expect(matchReadSourceFromEnv({ SUPABASE_URL: 'https://example.supabase.co' }, store)).toBe(store);
    const source = matchReadSourceFromEnv({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret-not-real' }, store, client);
    const app = hostedApp({ dist: mkdtempSync(join(tmpdir(), 'brick-arena-supabase-dist-')), proxy: { link: { baseUrl: standIn.url, model: 'jev-test', key: 'test-key-not-real' }, keyFrom: 'a test', debug: false, cap: createCap({ perVisitor: 10, total: 10 }) }, matches: store, matchReadSource: source, admin: ADMIN });
    const adminServer = createServer(app);
    await new Promise<void>(done => adminServer.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}${MATCHES_PATH}`)).status).toBe(401);
      expect((await fetch(`${url}${MATCHES_PATH}/${id}`)).status).toBe(401);
      expect(reads).toBe(0);
      const list = await fetch(`${url}${MATCHES_PATH}`, { headers: { authorization: adminHeader(ADMIN) } });
      expect((await list.json()).matches.map((match: MatchSummary) => match.id)).toEqual([id]);
      const record = await fetch(`${url}${MATCHES_PATH}/${id}`, { headers: { authorization: adminHeader(ADMIN) } });
      expect(record.headers.get('content-type')).toContain('application/x-ndjson');
      expect(parseRecord(await record.text()).map(line => line.type)).toEqual(['start', 'level']);
    } finally {
      adminServer.close();
    }
  });
});
