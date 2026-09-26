import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
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
import { createMatchStore, type MatchStore } from './matches';
import { MATCHES_PATH, newMatchId, parseRecord, timeline, type MatchLine } from './record';
import { hostedApp } from './serve';

// The hosted server over the local stand-in, in debug mode so the stand-in may
// play, with its match store in a temporary directory. Nothing reaches live Jev.
let standIn: { url: string; close: () => Promise<void> };
let server: Server;
let base: string;
let store: MatchStore;

beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), 'brick-arena-hosted-'));
  store = createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-matches-')));
  standIn = await startStandIn({ port: 0, ms: 1 });
  server = createServer(hostedApp({ dist, proxy: { link: { baseUrl: standIn.url, model: 'jev-test', key: 'test-key-not-real' }, keyFrom: 'a test', debug: true, cap: createCap({ perVisitor: 10_000, total: 10_000 }), log: () => {} }, matches: store }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await standIn.close();
});

const toServer: Sender = async (id, body) => (await fetch(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', body })).ok;
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
    const lines = parseRecord(await (await fetch(`${base}${MATCHES_PATH}/${id}`)).text());
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
    const cli = execFileSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/cli/src/match.ts'), id], { env: { ...process.env, MATCHES_DIR: store.dir }, encoding: 'utf8' });
    expect(cli.trim().split('\n')).toEqual(printed);
    const list = execFileSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/cli/src/match.ts')], { env: { ...process.env, MATCHES_DIR: store.dir }, encoding: 'utf8' });
    expect(list).toMatch(new RegExp(`^${id}  stand-in \\(debug\\), standard  levels: `, 'm'));

    const listed = await (await fetch(`${base}${MATCHES_PATH}`)).json() as { matches: Array<{ id: string; end: unknown; ballsLost: { human: number } }> };
    const summary = listed.matches.find(match => match.id === id)!;
    expect(summary.end).toMatchObject({ reason: 'final' });
    expect(summary.ballsLost.human).toBe(lines.filter(line => line.type === 'lost' && line.side === 'human').length);
  }, 60_000);

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

  it('stops taking lines at its size limits', () => {
    const small = createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-small-')), { maxTotalBytes: 400, maxMatchBytes: 300 });
    const a = newMatchId(new Date('2026-09-26T10:00:00Z')), b = newMatchId(new Date('2026-09-26T11:00:00Z'));
    expect(small.append(a, [start(a) as MatchLine])).toBe('ok');
    const level = { type: 'level', level: 0, name: 'x'.repeat(100) } as MatchLine;
    expect(small.append(a, [level])).toBe('ok');
    expect(small.append(a, [level])).toBe('match-full');
    expect(small.append(b, [start(b) as MatchLine, level])).toBe('full');
  });
});
