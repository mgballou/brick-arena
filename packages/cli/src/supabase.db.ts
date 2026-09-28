import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { levelNames } from '../../engine/src/index.ts';
import { createCap } from '../../jev/src/cap.ts';
import { createMatchStore } from '../../server/src/matches.ts';
import { MATCHES_PATH, newMatchId, tallyJev, type MatchLine } from '../../server/src/record.ts';
import { createRowWriter } from '../../server/src/rows.ts';
import { hostedApp } from '../../server/src/serve.ts';
import { clientFromEnv, restClient, tableClientFromEnv, type Row, type TableName } from '../../server/src/supabase.ts';
import { LOCAL, psql } from './supabase-local.ts';
import { exportMonth, matchRecord } from './supabase-read.ts';
import { checkAwake, keepAwake, prune } from './upkeep.ts';

// The Supabase path against a real Postgres and PostgREST (`pnpm test:db`,
// supabase/local/compose.yml): the server's writes, the export's paged reads
// and the weekly job's deletes, each through the code that runs them for real,
// with the environment it reads. supabase.test.ts proves the same code against
// a stub; this proves the stub told the truth.

const env = { SUPABASE_WRITES: '1', SUPABASE_URL: LOCAL.url, SUPABASE_SECRET_KEY: LOCAL.secretKey };
const secret = restClient({ url: LOCAL.url, key: LOCAL.secretKey });

const count = (table: TableName) => Number(psql(['-c', `select count(*) from ${table}`]).trim());
const counts = () => Object.fromEntries((['matches', 'jev_calls', 'match_events', 'level_progress', 'keep_awake'] as const).map(table => [table, count(table)]));

// Rows straight in, as the server would have left them.
async function put(table: TableName, rows: Row[]) {
  for (let at = 0; at < rows.length; at += 2000) {
    const answer = await secret.upsert(table, rows.slice(at, at + 2000));
    if (!answer.ok) throw new Error(`seeding ${table}: ${answer.status} ${answer.message}`);
  }
}

const matchRow = (id: string, startedAt: Date): Row => ({ id, app: 'brick-arena', started_at: startedAt.toISOString(), ended_at: new Date(startedAt.getTime() + 300_000).toISOString(), seed: 20260919, tuning: 'standard', opponent: 'live', end_reason: 'final', score_you: 90, score_jev: 60, jev_tally: null, build: 'local' });
const eventRow = (id: string, n: number): Row => ({ match_id: id, n, type: 'launch', level: 0, frame: n * 10, data: { side: 'human', x: 360, first: n === 0 } });
const callRow = (id: string, n: number): Row => ({ match_id: id, n, level: 0, frame: n * 10 + 5, tick: n * 10 + 5, lead: 3, question: 'target', options: ['landing', 'aim', 'angle-left', 'angle-right'], choice: 'aim', outcome: 'answered', answer_ms: 180, state: { bricks: '3210#' } });
const progressRow = (id: string): Row => ({ match_id: id, level: 0, samples: [[60, { score: 50 }, { score: 40 }]] });

beforeEach(() => {
  psql(['-c', 'truncate matches, keep_awake cascade']);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const side = (percent: number) => ({ score: percent * 10, percent, bricksLeft: 100 - percent, livesLeft: 3 });
const state = { bricks: '3210#', ball: { x: 1.5, y: 2.25 } };

// A match of two levels in three writes, with 40 of Jev's calls a level. Each
// level's lines go by frame, and at one frame events, then calls, then
// progress: the order the rows give back (supabase-read.ts).
function liveMatch(id: string): MatchLine[][] {
  const level = (level: number): MatchLine[] => {
    const body: MatchLine[] = [
      { type: 'launch', level, frame: 0, side: 'human', x: 360, first: level === 0 },
      { type: 'lost', level, frame: 60, side: 'jev', x: 120.5, lifeLost: true, livesLeft: 2 },
      ...Array.from({ length: 40 }, (_, n): MatchLine => ({ type: 'jev', level, frame: n * 3, tick: n * 3, lead: 3, question: n % 5 ? 'target' : 'chase', options: n % 5 ? ['landing', 'aim', 'angle-left', 'angle-right'] : [0, 1.5, 2], state, outcome: n % 7 ? 'answered' : 'timeout', ...n % 7 ? { choice: 'aim' } : {}, ms: 150.4 + n })),
      { type: 'progress', level, frame: 60, human: side(5), jev: side(4) },
      { type: 'progress', level, frame: 120, human: side(9), jev: side(6) },
    ];
    const kind = (line: MatchLine) => line.type === 'jev' ? 1 : line.type === 'progress' ? 2 : 0;
    body.sort((a, b) => (a as { frame: number }).frame - (b as { frame: number }).frame || kind(a) - kind(b));
    return [
      { type: 'level', level, name: levelNames[level] },
      ...body,
      { type: 'levelEnd', level, frame: 130, winner: 'human', human: { ...side(9), cleared: false }, jev: { ...side(6), cleared: false } },
    ];
  };
  const [first, second] = [level(0), level(1)];
  return [
    [{ type: 'start', v: 1, id, at: '', seed: 20260919, tuning: 'standard', opponent: 'live', debug: false }, ...first.slice(0, 20)],
    [...first.slice(20), ...second],
    [{ type: 'end', at: '', reason: 'final', human: 90, jev: 60 }],
  ];
}

describe('the server\'s writes', () => {
  it('writes a match posted to the hosted server into every table, and it reads back as the same record', async () => {
    const logged: string[] = [];
    const client = clientFromEnv(env, line => logged.push(line));
    expect(client).not.toBeNull();
    const writer = createRowWriter(client!, { build: 'local', log: line => logged.push(line), retryMs: 60_000 });
    const store = createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-db-')), undefined, undefined, writer.take);
    const dist = mkdtempSync(join(tmpdir(), 'brick-arena-hosted-'));
    const server = createServer(hostedApp({ dist, proxy: { link: { baseUrl: 'http://127.0.0.1:9', model: 'jev-test', key: 'test-key-not-real' }, keyFrom: 'a test', debug: false, cap: createCap({ perVisitor: 1, total: 1 }), log: () => {} }, matches: store, admin: null }));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const id = newMatchId();
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const lines of liveMatch(id)) {
        const response = await fetch(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', body: lines.map(line => JSON.stringify(line)).join('\n') });
        expect(response.status).toBe(200);
        await writer.flush();
      }
    } finally {
      server.close();
    }
    expect(logged).toEqual([]);
    expect(writer.pendingBytes()).toBe(0);
    expect(counts()).toEqual({ matches: 1, jev_calls: 80, match_events: 8, level_progress: 2, keep_awake: 0 });

    // The file the store kept, which the rows must give back line for line.
    const kept = readFileSync(join(store.dir, `${id}.ndjson`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as MatchLine);
    const record = await matchRecord(tableClientFromEnv(env)!, id);
    expect(record?.lines).toEqual(kept.map(line => line.type === 'jev' ? { ...line, ms: Math.round(line.ms) } : line));
    expect(record?.tally).toEqual(tallyJev(kept));
    const [row] = psql(['-c', `select build || ' ' || end_reason || ' ' || score_you || ' ' || score_jev from matches where id = '${id}'`]).trim().split('\n');
    expect(row).toBe('local final 90 60');
  });
});

describe('the export', () => {
  it('reads a month over more than one page, and writes every line of it', async () => {
    // Supabase's cap, which the compose file sets: one read gives 1000 rows at most.
    const month = new Date('2026-08-01T00:00:00.000Z').getTime();
    const ids = Array.from({ length: 1250 }, (_, n) => `202608-${String(n).padStart(4, '0')}`);
    await put('matches', [
      ...ids.map((id, n) => matchRow(id, new Date(month + n * 60_000))),
      // Either side of August, so not in it.
      matchRow('202607-last', new Date(month - 1)),
      matchRow('202609-first', new Date('2026-09-01T00:00:00.000Z')),
    ]);
    await put('match_events', ids.map(id => eventRow(id, 0)));
    // The first 20 matches, one read of child rows, hold 1200 of Jev's calls.
    await put('jev_calls', ids.slice(0, 20).flatMap(id => Array.from({ length: 60 }, (_, n) => callRow(id, n))));
    await put('level_progress', ids.map(progressRow));
    const capped = await fetch(`${LOCAL.url}/rest/v1/matches?select=id`, { headers: { apikey: LOCAL.secretKey } });
    expect(await capped.json()).toHaveLength(1000);

    const read = vi.spyOn(globalThis, 'fetch');
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-export-'));
    const result = await exportMonth(tableClientFromEnv(env)!, { month: '2026-08', dir });
    // start, the launch, a progress sample and end for each match, and the calls.
    expect(result).toMatchObject({ matches: 1250, lines: 1250 * 4 + 1200, pruned: [] });

    const lines = gunzipSync(readFileSync(result.path)).toString('utf8').trim().split('\n').map(line => JSON.parse(line) as MatchLine);
    expect(lines).toHaveLength(1250 * 4 + 1200);
    const starts = lines.filter(line => line.type === 'start').map(line => (line as Extract<MatchLine, { type: 'start' }>).id);
    expect(starts).toEqual(ids);
    expect(lines.filter(line => line.type === 'jev')).toHaveLength(1200);

    const pages = (table: TableName) => read.mock.calls.map(([url]) => new URL(String(url))).filter(url => url.pathname.endsWith(`/${table}`)).map(url => url.searchParams.get('offset'));
    expect(pages('matches')).toEqual(['0', '1000', '1250']);
    // The first chunk's calls, in two pages and an empty one; the rest have none.
    expect(pages('jev_calls').slice(0, 3)).toEqual(['0', '1000', '1200']);
    expect(pages('jev_calls').filter(offset => offset !== '0')).toEqual(['1000', '1200']);
  });
});

describe('the weekly job', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');
  const DAY = 86_400_000;

  it('prunes the full rows of matches past 90 days, and counts each delete from Content-Range', async () => {
    const old = Array.from({ length: 150 }, (_, n) => `old-${String(n).padStart(3, '0')}`);
    const young = Array.from({ length: 5 }, (_, n) => `young-${n}`);
    await put('matches', [...old.map(id => matchRow(id, new Date(now.getTime() - 100 * DAY))), ...young.map(id => matchRow(id, new Date(now.getTime() - 10 * DAY)))]);
    await put('match_events', [...old, ...young].flatMap(id => [eventRow(id, 0), eventRow(id, 1)]));
    await put('jev_calls', [...old, ...young].map(id => callRow(id, 0)));
    await put('level_progress', [...old, ...young].map(progressRow));
    await put('keep_awake', [95, 93, 91, 89, 7].map(days => ({ at: new Date(now.getTime() - days * DAY).toISOString() })));

    const client = tableClientFromEnv(env)!;
    expect(await checkAwake(client, LOCAL.url)).toBe('Supabase answered the pause check.');
    expect(await keepAwake(client, now)).toBe(`Inserted the keep-awake row at ${now.toISOString()}.`);
    const before = new Date(now.getTime() - 90 * DAY).toISOString();
    // 150 old matches take two deletes a table, whose counts add up.
    expect(await prune(client, now)).toBe(`Pruned matches begun before ${before} (150 kept in matches): 150 jev_calls, 300 match_events, 150 level_progress rows, and 3 keep_awake rows.`);
    expect(counts()).toEqual({ matches: 155, jev_calls: 5, match_events: 10, level_progress: 5, keep_awake: 3 });
    expect(psql(['-c', "select string_agg(distinct match_id, ',' order by match_id) from match_events"]).trim()).toBe(young.join(','));

    // Nothing left to prune: the counts are 0, not unknown.
    expect(await prune(client, now)).toBe(`Pruned matches begun before ${before} (150 kept in matches): 0 jev_calls, 0 match_events, 0 level_progress rows, and 0 keep_awake rows.`);
  });
});

describe('the keys', () => {
  it('lets the publishable key read and write nothing, as row-level security with no policy says', async () => {
    const at = new Date();
    await put('matches', [matchRow('held', at)]);
    const publishable = restClient({ url: LOCAL.url, key: LOCAL.publishableKey });
    expect(await publishable.select('matches', { order: [['id', 'asc']] })).toEqual({ ok: true, rows: [] });
    expect(await publishable.upsert('keep_awake', [{ at: at.toISOString() }])).toMatchObject({ ok: false, status: 401 });
    expect(await publishable.remove('matches', [['id', 'eq', 'held']])).toEqual({ ok: true, count: 0 });
    expect(count('matches')).toBe(1);

    const unknown = restClient({ url: LOCAL.url, key: 'sb_secret_not_this_one' });
    expect(await unknown.select('matches', { order: [['id', 'asc']] })).toMatchObject({ ok: false, status: 401 });
  });
});
