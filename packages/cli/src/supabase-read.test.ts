import { gunzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { levelNames } from '../../engine/src/index';
import { type MatchLine } from '../../server/src/record';
import { createRowWriter } from '../../server/src/rows';
import { stubClient, type StubClient } from '../../server/src/supabase';
import { exportMonth, exportName, lastMonth, linesOf, matchRecord, monthRange, recentMatches } from './supabase-read';
import { prune } from './upkeep';

// The record read back out of the rows the server writes, all through the
// stub: no test here reaches Supabase.

const side = (percent: number) => ({ score: percent * 10, percent, bricksLeft: 100 - percent, livesLeft: 3 });
const state = { bricks: '3210#', ball: { x: 1.5, y: 2.25 } };

// A live match of two levels, in record order, as the browser writes it.
function liveMatch(id: string, at: string): MatchLine[] {
  const later = new Date(Date.parse(at) + 300_000).toISOString();
  return [
    { type: 'start', v: 1, id, at, seed: 20260919, tuning: 'standard', opponent: 'live', debug: false },
    { type: 'level', level: 0, name: levelNames[0] },
    { type: 'launch', level: 0, frame: 0, side: 'human', x: 360, first: true },
    { type: 'jev', level: 0, frame: 12, tick: 12, lead: 3, question: 'target', options: ['landing', 'aim', 'angle-left', 'angle-right'], state, outcome: 'answered', choice: 'aim', ms: 184 },
    { type: 'progress', level: 0, frame: 60, human: side(5), jev: side(4) },
    { type: 'lost', level: 0, frame: 90, side: 'jev', x: 120.5, lifeLost: true, livesLeft: 2 },
    { type: 'jev', level: 0, frame: 95, tick: 95, lead: 3, question: 'chase', options: [0, 1, 2], state, outcome: 'timeout', ms: 400 },
    { type: 'progress', level: 0, frame: 120, human: side(9), jev: side(6) },
    { type: 'levelEnd', level: 0, frame: 130, winner: 'human', human: { ...side(9), cleared: false }, jev: { ...side(6), cleared: false } },
    { type: 'level', level: 1, name: levelNames[1] },
    { type: 'launch', level: 1, frame: 0, side: 'jev', x: 300, first: true },
    { type: 'jev', level: 1, frame: 30, tick: 30, lead: 2, question: 'target', options: ['landing', 'aim', 'angle-left', 'angle-right'], state, outcome: 'answered', choice: 'landing', ms: 150 },
    { type: 'progress', level: 1, frame: 60, human: side(2), jev: side(3) },
    { type: 'levelEnd', level: 1, frame: 70, winner: 'jev', human: { ...side(2), cleared: false }, jev: { ...side(3), cleared: false } },
    { type: 'end', at: later, reason: 'final', human: 110, jev: 90 },
  ];
}

// Matches written as the server writes them, into the stub's tables.
async function written(matches: Array<[id: string, at: string]>, client: StubClient = stubClient()) {
  const writer = createRowWriter(client, { log: () => {} });
  const all = matches.map(([id, at]) => liveMatch(id, at));
  for (const lines of all) writer.take(lines[0].type === 'start' ? lines[0].id : '', lines);
  await writer.flush();
  return { client, all };
}

describe('the record out of Supabase', () => {
  it('gives back the lines the rows were written from', async () => {
    const { client, all } = await written([['20261003-101500-aaaaaa', '2026-10-03T10:15:00.000Z']]);
    const found = await matchRecord(client, '20261003-101500-aaaaaa');
    expect(found!.lines).toEqual(all[0]);
    expect(found!.tally).toMatchObject({ calls: 3, answered: 2, missed: 1, target: { aim: 1, landing: 1 } });
    expect(await matchRecord(client, '20261003-101500-zzzzzz')).toBeNull();
  });

  it('puts the level line first and levelEnd last, and orders a frame events, calls, then progress', () => {
    const match = { id: 'm', started_at: '2026-10-03 10:15:00+00', seed: 1, tuning: 'standard', opponent: 'live', ended_at: null };
    const events = [
      { match_id: 'm', n: 0, type: 'levelEnd', level: 0, frame: 60, data: { winner: 'tie' } },
      { match_id: 'm', n: 1, type: 'lost', level: 0, frame: 60, data: { side: 'human' } },
      { match_id: 'm', n: 2, type: 'level', level: 0, frame: null, data: { name: 'x' } },
    ];
    const calls = [{ match_id: 'm', n: 0, level: 0, frame: 60, tick: 60, lead: 0, question: 'track', options: [], choice: null, outcome: 'offline', answer_ms: 5, state }];
    const progress = [{ match_id: 'm', level: 0, samples: [[60, side(1), side(1)]] }];
    const lines = linesOf(match, events, calls, progress);
    expect(lines.map(line => line.type)).toEqual(['start', 'level', 'lost', 'jev', 'progress', 'levelEnd']);
    // Postgres's timestamp, as the server wrote it; no `choice` when there was none.
    expect(lines[0]).toMatchObject({ at: '2026-10-03T10:15:00.000Z', debug: false, v: 1 });
    expect(lines[3]).not.toHaveProperty('choice');
    expect(lines[1]).not.toHaveProperty('frame');
  });

  it('lists the recent matches newest first, with the tally from the match row', async () => {
    const { client } = await written([['20261003-101500-aaaaaa', '2026-10-03T10:15:00.000Z'], ['20261004-101500-bbbbbb', '2026-10-04T10:15:00.000Z']]);
    const recent = await recentMatches(client, 1);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ id: '20261004-101500-bbbbbb', levels: [{ level: 0, winner: 'human' }, { level: 1, winner: 'jev' }], ballsLost: { human: 0, jev: 1 }, end: { reason: 'final', human: 110, jev: 90 } });
    expect(recent[0].jev.calls).toBe(3);
    // The list never reads the calls or the progress.
    const read = client.select;
    const tables: string[] = [];
    client.select = (table, query) => { tables.push(table); return read(table, query); };
    await recentMatches(client, 5);
    expect(tables.sort()).toEqual(['match_events', 'matches']);
  });

  it('says why a read failed', async () => {
    const client = stubClient();
    client.refuse({ ok: false, status: 503, message: 'paused' });
    await expect(matchRecord(client, 'x')).rejects.toThrow('Supabase refused a read of matches: 503 paused');
  });
});

describe('the monthly export', () => {
  const october: Array<[string, string]> = [['20261001-000000-aaaaaa', '2026-10-01T00:00:00.000Z'], ['20261031-235959-bbbbbb', '2026-10-31T23:59:59.000Z']];
  const outside: Array<[string, string]> = [['20260930-235959-cccccc', '2026-09-30T23:59:59.000Z'], ['20261101-000000-dddddd', '2026-11-01T00:00:00.000Z']];
  const read = (path: string) => gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

  it('writes the matches begun in the month, in UTC, as record lines in one gzipped file', async () => {
    const { client, all } = await written([...outside, ...october]);
    const dir = join(mkdtempSync(join(tmpdir(), 'brick-arena-export-')), 'exports');
    const result = await exportMonth(client, { month: '2026-10', dir });
    expect(result).toEqual({ path: join(dir, 'brick-arena-2026-10.ndjson.gz'), matches: 2, lines: 30, pruned: [] });
    expect(read(result.path)).toEqual([...all[2], ...all[3]]);
    expect(readdirSync(dir)).toEqual([exportName('2026-10')]);
  });

  it('never replaces an export unless forced, since one made after the prune holds less', async () => {
    const { client } = await written(october);
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-export-'));
    await exportMonth(client, { month: '2026-10', dir });
    const first = readFileSync(join(dir, exportName('2026-10')));
    // Ninety days on, the prune has taken October's calls and events.
    await prune(client, new Date('2027-02-01T00:00:00Z'));
    await expect(exportMonth(client, { month: '2026-10', dir })).rejects.toThrow('--force');
    expect(readFileSync(join(dir, exportName('2026-10')))).toEqual(first);

    const forced = await exportMonth(client, { month: '2026-10', dir, force: true });
    expect(forced.pruned).toEqual(october.map(([id]) => id));
    expect(read(forced.path).map(line => line.type)).toEqual(['start', 'end', 'start', 'end']);
  });

  it('leaves no file when a read fails partway', async () => {
    const { client } = await written(october);
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-export-'));
    const read = client.select;
    client.select = (table, query) => table === 'jev_calls' ? Promise.resolve({ ok: false, status: 0, message: 'fetch failed' }) : read(table, query);
    await expect(exportMonth(client, { month: '2026-10', dir })).rejects.toThrow('jev_calls: no answer fetch failed');
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, exportName('2026-10')))).toBe(false);
  });

  it('reads months as YYYY-MM in UTC, and takes the last whole one by default', () => {
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' });
    expect(() => monthRange('2026-13')).toThrow('YYYY-MM');
    expect(() => monthRange('October')).toThrow('YYYY-MM');
    expect(lastMonth(new Date('2027-01-15T12:00:00Z'))).toBe('2026-12');
    expect(lastMonth(new Date('2026-10-01T00:00:00Z'))).toBe('2026-09');
  });
});
