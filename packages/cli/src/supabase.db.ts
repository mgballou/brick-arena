import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { levelNames } from '../../engine/src/index.ts';
import { createCap } from '../../jev/src/cap.ts';
import { createMatchStore } from '../../server/src/matches.ts';
import { MATCHES_PATH, newMatchId, tallyJev, type MatchLine } from '../../server/src/record.ts';
import { createRowWriter } from '../../server/src/rows.ts';
import { hostedApp } from '../../server/src/serve.ts';
import { clientFromEnv, tableClientFromEnv, type TableName } from '../../server/src/supabase.ts';
import { LOCAL, psql } from './supabase-local.ts';
import { matchRecord } from './supabase-read.ts';

// The Supabase path against a real Postgres and PostgREST (`pnpm test:db`,
// supabase/local/compose.yml): the server's writes, the export's paged reads
// and the weekly job's deletes, each through the code that runs them for real,
// with the environment it reads. supabase.test.ts proves the same code against
// a stub; this proves the stub told the truth.

const env = { SUPABASE_WRITES: '1', SUPABASE_URL: LOCAL.url, SUPABASE_SECRET_KEY: LOCAL.secretKey };
const count = (table: TableName) => Number(psql(['-c', `select count(*) from ${table}`]).trim());
const counts = () => Object.fromEntries((['matches', 'jev_calls', 'match_events', 'level_progress', 'keep_awake'] as const).map(table => [table, count(table)]));

beforeEach(() => {
  psql(['-c', 'truncate matches, keep_awake cascade']);
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
