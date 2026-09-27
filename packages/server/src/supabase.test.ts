import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { levelNames } from '../../engine/src/index';
import { createCap } from '../../jev/src/cap';
import { createMatchStore } from './matches';
import { MATCHES_PATH, newMatchId, type MatchLine } from './record';
import { createRowWriter } from './rows';
import { hostedApp } from './serve';
import { clientFromEnv, CONFLICT, restClient, stubClient, type Row, type StubClient, type TableName } from './supabase';

// The rows each match leaves in Supabase, written through the stub: no test
// here reaches Supabase. The migration runs against a local Postgres only when
// one answers (BRICK_ARENA_TEST_PG, or Herd's on 127.0.0.1:5432).

const side = (percent: number) => ({ score: percent * 10, percent, bricksLeft: 100 - percent, livesLeft: 3 });
const state = { bricks: '3210#', ball: { x: 1.5, y: 2.25 } };

// A short live match with a line of every type, in two writes.
function liveMatch(id: string, start: Partial<Extract<MatchLine, { type: 'start' }>> = {}): MatchLine[][] {
  return [
    [
      { type: 'start', v: 1, id, at: '', seed: 20260919, tuning: 'standard', opponent: 'live', debug: false, ...start },
      { type: 'level', level: 0, name: levelNames[0] },
      { type: 'launch', level: 0, frame: 0, side: 'human', x: 360, first: true },
      { type: 'jev', level: 0, frame: 12, tick: 12, lead: 3, question: 'target', options: ['landing', 'aim', 'angle-left', 'angle-right'], state, outcome: 'answered', choice: 'aim', ms: 183.6 },
      { type: 'progress', level: 0, frame: 60, human: side(5), jev: side(4) },
    ],
    [
      { type: 'lost', level: 0, frame: 90, side: 'jev', x: 120.5, lifeLost: true, livesLeft: 2 },
      { type: 'jev', level: 0, frame: 95, tick: 95, lead: 3, question: 'chase', options: [0, 1, 2], state, outcome: 'timeout', ms: 400 },
      { type: 'progress', level: 0, frame: 120, human: side(9), jev: side(6) },
      { type: 'levelEnd', level: 0, frame: 130, winner: 'human', human: { ...side(9), cleared: false }, jev: { ...side(6), cleared: false } },
      { type: 'end', at: '', reason: 'final', human: 90, jev: 60 },
    ],
  ];
}

// A store in a temporary directory whose writes feed a row writer on the stub.
function setup(options: Parameters<typeof createRowWriter>[1] = {}) {
  const client = stubClient();
  const logged: string[] = [];
  const writer = createRowWriter(client, { build: 'abc123', log: line => logged.push(line), retryMs: 60_000, ...options });
  const store = createMatchStore(mkdtempSync(join(tmpdir(), 'brick-arena-rows-')), undefined, undefined, writer.take);
  return { client, writer, store, logged };
}

const rowsOf = (client: StubClient, table: TableName) => client.calls.filter(call => call.table === table).flatMap(call => call.rows);
const lastMatchRow = (client: StubClient) => rowsOf(client, 'matches').at(-1)!;

describe('each match as rows', () => {
  it('writes a live match to all four tables, the match row first', async () => {
    const { client, writer, store } = setup();
    const id = newMatchId();
    for (const lines of liveMatch(id)) expect(store.append(id, lines)).toBe('ok');
    await writer.flush();
    expect(client.calls[0].table).toBe('matches');
    // The second write's level progress took the place of the first's, still waiting.
    expect(client.calls.map(call => call.table)).toEqual(['matches', 'match_events', 'jev_calls', 'level_progress', 'matches', 'match_events', 'jev_calls']);

    const match = lastMatchRow(client);
    expect(match).toMatchObject({ id, app: 'brick-arena', seed: 20260919, tuning: 'standard', opponent: 'live', end_reason: 'final', score_you: 90, score_jev: 60, build: 'abc123' });
    // The server's clock, as the file has it.
    expect(match.started_at).toBe(JSON.parse(readFileSync(join(store.dir, `${id}.ndjson`), 'utf8').split('\n')[0]).at);
    expect(Date.parse(match.ended_at as string)).not.toBeNaN();
    expect(match.jev_tally).toMatchObject({ calls: 2, answered: 1, missed: 1, target: { aim: 1 } });

    expect(rowsOf(client, 'jev_calls')).toEqual([
      { match_id: id, n: 0, level: 0, frame: 12, tick: 12, lead: 3, question: 'target', options: ['landing', 'aim', 'angle-left', 'angle-right'], choice: 'aim', outcome: 'answered', answer_ms: 184, state },
      { match_id: id, n: 1, level: 0, frame: 95, tick: 95, lead: 3, question: 'chase', options: [0, 1, 2], choice: null, outcome: 'timeout', answer_ms: 400, state },
    ]);
    expect(rowsOf(client, 'match_events').map(row => [row.n, row.type, row.level, row.frame])).toEqual([[0, 'level', 0, null], [1, 'launch', 0, 0], [2, 'lost', 0, 90], [3, 'levelEnd', 0, 130]]);
    expect(rowsOf(client, 'match_events')[2].data).toEqual({ side: 'jev', x: 120.5, lifeLost: true, livesLeft: 2 });
    // The level's row, whole each time, so the last one holds every sample.
    expect(rowsOf(client, 'level_progress').at(-1)).toEqual({ match_id: id, level: 0, samples: [[60, side(5), side(4)], [120, side(9), side(6)]] });
  });

  it('writes nothing for the stand-in or debug play', async () => {
    const { client, writer, store } = setup();
    for (const start of [{ opponent: 'stand-in' as const }, { debug: true }]) {
      const id = newMatchId();
      for (const lines of liveMatch(id, start)) expect(store.append(id, lines)).toBe('ok');
    }
    await writer.flush();
    expect(client.calls).toEqual([]);
  });

  it('writes nothing the match store refused', async () => {
    const { client, writer, store } = setup();
    const id = newMatchId();
    const [first, rest] = liveMatch(id);
    expect(store.append(id, rest)).toBe('no-start');
    expect(store.append(newMatchId(new Date(Date.now() - 3 * 60 * 60 * 1000)), first)).not.toBe('ok');
    await writer.flush();
    expect(client.calls).toEqual([]);
  });

  it('keeps refused rows and sends them when Supabase answers again, the newest match row only', async () => {
    const { client, writer, store, logged } = setup();
    const id = newMatchId();
    client.refuse({ ok: false, status: 503, message: 'paused' });
    for (const lines of liveMatch(id)) store.append(id, lines);
    await writer.flush();
    await writer.flush();
    expect(client.calls).toEqual([]);
    expect(writer.pendingBytes()).toBeGreaterThan(0);
    // One line for the whole outage, not one a retry.
    expect(logged).toEqual([`refused 1 matches rows of ${id}, kept to retry: 503 paused`]);

    client.refuse(null);
    await writer.flush();
    expect(writer.pendingBytes()).toBe(0);
    expect(logged.at(-1)).toBe('writes go through again');
    expect(rowsOf(client, 'matches')).toHaveLength(1);
    expect(lastMatchRow(client).end_reason).toBe('final');
    expect(rowsOf(client, 'jev_calls').map(row => row.n)).toEqual([0, 1]);
    expect(rowsOf(client, 'level_progress')).toHaveLength(1);
  });

  it('drops rows Postgres can never take, and sends the rest', async () => {
    const client = stubClient();
    const logged: string[] = [];
    const picky = createRowWriter({ upsert: async (table, rows) => table === 'jev_calls' ? { ok: false, status: 400, message: 'invalid input syntax for type integer' } : client.upsert(table, rows) }, { log: line => logged.push(line) });
    const id = newMatchId();
    for (const lines of liveMatch(id)) picky.take(id, lines);
    await picky.flush();
    expect(logged).toEqual(Array(2).fill(`refused 1 jev_calls rows of ${id}, dropped: 400 invalid input syntax for type integer`));
    expect(rowsOf(client, 'match_events')).toHaveLength(4);
    expect(picky.pendingBytes()).toBe(0);
  });

  it('keeps at most its limit waiting, dropping the oldest', async () => {
    const { client, writer, store, logged } = setup({ maxPendingBytes: 1500 });
    client.refuse({ ok: false, status: 0, message: 'fetch failed' });
    const id = newMatchId();
    for (const lines of liveMatch(id)) store.append(id, lines);
    await writer.flush();
    expect(writer.pendingBytes()).toBeLessThanOrEqual(1500);
    expect(logged.some(line => /^dropped \d+ waiting rows, past 1500 bytes$/.test(line))).toBe(true);
  });

  it('writes a match posted to the hosted server, after answering it', async () => {
    const { client, writer, store } = setup();
    const dist = mkdtempSync(join(tmpdir(), 'brick-arena-hosted-'));
    const server = createServer(hostedApp({ dist, proxy: { link: { baseUrl: 'http://127.0.0.1:9', model: 'jev-test', key: 'test-key-not-real' }, keyFrom: 'a test', debug: false, cap: createCap({ perVisitor: 1, total: 1 }), log: () => {} }, matches: store, admin: null }));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const id = newMatchId();
      for (const lines of liveMatch(id)) {
        const response = await fetch(`${base}${MATCHES_PATH}/${id}`, { method: 'POST', body: lines.map(line => JSON.stringify(line)).join('\n') });
        expect(response.status).toBe(200);
      }
      await writer.flush();
      expect(rowsOf(client, 'jev_calls')).toHaveLength(2);
      expect(lastMatchRow(client).end_reason).toBe('final');
    } finally {
      server.close();
    }
  });
});

describe('the client', () => {
  it('is chosen only with the flag and SUPABASE_URL both set', () => {
    const logged: string[] = [];
    const log = (line: string) => logged.push(line);
    const url = 'https://example.supabase.co', key = 'sb_secret_not-real';
    expect(clientFromEnv({}, log)).toBeNull();
    expect(clientFromEnv({ SUPABASE_URL: url, SUPABASE_SECRET_KEY: key }, log)).toBeNull();
    expect(clientFromEnv({ SUPABASE_WRITES: '0', SUPABASE_URL: url, SUPABASE_SECRET_KEY: key }, log)).toBeNull();
    expect(logged).toEqual([]);
    expect(clientFromEnv({ SUPABASE_WRITES: '1', SUPABASE_SECRET_KEY: key }, log)).toBeNull();
    expect(clientFromEnv({ SUPABASE_WRITES: '1', SUPABASE_URL: url }, log)).toBeNull();
    expect(logged).toEqual(['SUPABASE_WRITES is on but SUPABASE_URL is not set, so no rows are written', 'SUPABASE_WRITES is on but SUPABASE_SECRET_KEY is not set, so no rows are written']);
    expect(clientFromEnv({ SUPABASE_WRITES: '1', SUPABASE_URL: url, SUPABASE_SECRET_KEY: key }, log)).not.toBeNull();
    expect(logged.join('\n')).not.toContain(key);
  });

  it('upserts on the table key with the secret key on apikey alone', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => (sent.push({ url, init }), new Response(null, { status: 201 }))) as typeof fetch;
    const client = restClient({ url: 'https://example.supabase.co/', key: 'sb_secret_not-real', fetch: fake });
    expect(await client.upsert('jev_calls', [{ match_id: 'x', n: 0 }])).toEqual({ ok: true });
    expect(sent[0].url).toBe('https://example.supabase.co/rest/v1/jev_calls?on_conflict=match_id,n');
    expect(sent[0].init.headers).toEqual({ apikey: 'sb_secret_not-real', 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' });
    expect(JSON.parse(sent[0].init.body as string)).toEqual([{ match_id: 'x', n: 0 }]);
  });

  it('turns a refusal or no answer into a result, never a throw', async () => {
    const refusing = restClient({ url: 'https://example.supabase.co', key: 'k', fetch: (async () => new Response('{"message":"paused"}', { status: 503 })) as typeof fetch });
    expect(await refusing.upsert('matches', [])).toEqual({ ok: false, status: 503, message: '{"message":"paused"}' });
    const silent = restClient({ url: 'https://example.supabase.co', key: 'k', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    expect(await silent.upsert('matches', [])).toEqual({ ok: false, status: 0, message: 'fetch failed' });
  });
});

// The migrations as one script, and each table's columns as the SQL names them.
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const migrationSql = () => readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(join(MIGRATIONS, name), 'utf8')).join('\n');
function tablesOf(sql: string) {
  const tables = new Map<string, Array<{ name: string; required: boolean }>>();
  for (const [, table, body] of sql.matchAll(/create table (\w+) \(([\s\S]*?)\n\);/g)) {
    tables.set(table, body.split('\n').map(line => line.replace(/--.*$/, '').trim()).filter(line => line && !line.startsWith('primary key')).map(line => ({
      name: line.split(/\s+/)[0],
      required: /\bnot null\b/.test(line) && !/\bdefault\b/.test(line) || /\bprimary key\b/.test(line),
    })));
  }
  return tables;
}

async function writtenRows() {
  const { client, writer, store } = setup();
  const id = newMatchId();
  for (const lines of liveMatch(id)) store.append(id, lines);
  await writer.flush();
  return client.calls;
}

describe('the migration', () => {
  const sql = migrationSql();
  const tables = tablesOf(sql);

  it('makes the four tables, each with row-level security on and no policy', () => {
    expect([...tables.keys()].sort()).toEqual(Object.keys(CONFLICT).sort());
    for (const table of tables.keys()) expect(sql).toMatch(new RegExp(`alter table ${table} enable row level security;`));
    expect(sql).not.toMatch(/create policy/i);
  });

  it('has a column for every row the server writes, and every row fills the required ones', async () => {
    for (const { table, rows } of await writtenRows()) {
      const columns = tables.get(table)!;
      for (const row of rows) {
        expect(Object.keys(row).filter(key => !columns.some(column => column.name === key)), table).toEqual([]);
        for (const column of columns.filter(column => column.required)) expect(row[column.name], `${table}.${column.name}`).not.toBeNull();
      }
    }
  });

  // Each upsert the way the Data API runs it: the rows through
  // jsonb_populate_recordset, merged on the table's key.
  const pg = process.env.BRICK_ARENA_TEST_PG ?? 'postgresql://root@127.0.0.1:5432/postgres';
  const psql = (url: string, args: string[]) => execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', url, ...args], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  let reachable = false;
  try {
    reachable = psql(pg, ['-c', 'select 1']).trim() === '1';
  } catch {
    // No local Postgres: the parse above is the check.
  }

  it.skipIf(!reachable)('runs on a local Postgres and takes every row the server writes', async () => {
    const name = `brick_arena_migration_${process.pid}`;
    const db = pg.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
    psql(pg, ['-c', `drop database if exists ${name} with (force)`, '-c', `create database ${name}`]);
    try {
      const dir = mkdtempSync(join(tmpdir(), 'brick-arena-sql-'));
      writeFileSync(join(dir, 'migration.sql'), sql);
      psql(db, ['-f', join(dir, 'migration.sql')]);
      const upserts = (await writtenRows()).map(({ table, rows }: { table: TableName; rows: Row[] }) => {
        const keys = CONFLICT[table].split(',');
        const rest = tables.get(table)!.map(column => column.name).filter(column => !keys.includes(column));
        return `insert into ${table} select * from jsonb_populate_recordset(null::${table}, $j$${JSON.stringify(rows)}$j$::jsonb) on conflict (${keys.join(', ')}) do update set ${rest.map(column => `${column} = excluded.${column}`).join(', ')};`;
      });
      writeFileSync(join(dir, 'rows.sql'), upserts.join('\n'));
      psql(db, ['-f', join(dir, 'rows.sql')]);
      const counts = psql(db, ['-c', 'select (select count(*) from matches), (select count(*) from jev_calls), (select count(*) from match_events), (select count(*) from level_progress)']).trim();
      expect(counts).toBe('1|2|4|1');
      expect(psql(db, ['-c', "select jsonb_array_length(samples) from level_progress"]).trim()).toBe('2');
      const secured = psql(db, ['-c', "select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class where relname in ('matches', 'jev_calls', 'match_events', 'level_progress')"]).trim();
      expect(secured).toBe('jev_calls:true,level_progress:true,match_events:true,matches:true');
      expect(psql(db, ['-c', 'select count(*) from pg_policies']).trim()).toBe('0');
    } finally {
      psql(pg, ['-c', `drop database if exists ${name} with (force)`]);
    }
  });
});
