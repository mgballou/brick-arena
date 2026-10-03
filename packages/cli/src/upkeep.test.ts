import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stubClient, type Row, type StubClient } from '../../server/src/supabase';
import { checkAwake, keepAwake, projectRef, prune } from './upkeep';

// The weekly job's steps, against the stub: no test here reaches Supabase.

const DAY = 86_400_000;
const now = new Date('2027-01-01T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

// `count` matches begun `days` ago, each with a row in every table.
function seed(client: StubClient, days: number, count: number, tag: string) {
  for (let n = 0; n < count; n++) {
    const match_id = `${tag}-${String(n).padStart(3, '0')}`;
    client.tables.matches.push({ id: match_id, started_at: daysAgo(days), jev_tally: { calls: 1 } });
    client.tables.jev_calls.push({ match_id, n: 0 });
    client.tables.match_events.push({ match_id, n: 0 }, { match_id, n: 1 });
    client.tables.level_progress.push({ match_id, level: 0 });
  }
}
const ids = (rows: Row[]) => [...new Set(rows.map(row => row.match_id ?? row.id))];

describe('the weekly job', () => {
  it('prunes the full rows of matches begun more than 90 days ago, and keeps every match row', async () => {
    const client = stubClient();
    // More old matches than one delete names, so the prune takes two.
    seed(client, 91, 150, 'old');
    seed(client, 89, 2, 'new');
    client.tables.keep_awake.push({ at: daysAgo(120) }, { at: daysAgo(7) });
    const removes: number[] = [];
    const remove = client.remove;
    client.remove = (table, where) => { removes.push(table === 'jev_calls' ? 1 : 0); return remove(table, where); };

    expect(await prune(client, now)).toBe(`Pruned matches begun before ${daysAgo(90)} (150 kept in matches): 150 jev_calls, 300 match_events, 150 level_progress rows, and 1 keep_awake rows.`);
    expect(removes.filter(Boolean)).toHaveLength(2);
    for (const table of ['jev_calls', 'match_events', 'level_progress'] as const) expect(ids(client.tables[table])).toEqual(['new-000', 'new-001']);
    expect(client.tables.matches).toHaveLength(152);
    expect(client.tables.keep_awake).toEqual([{ at: daysAgo(7) }]);

    // A second run finds nothing left to delete.
    expect(await prune(client, now)).toContain(': 0 jev_calls, 0 match_events, 0 level_progress rows, and 0 keep_awake rows.');
  });

  it('says "some" when the Data API does not count what it deleted', async () => {
    const client = stubClient();
    seed(client, 100, 1, 'old');
    const remove = client.remove;
    client.remove = async (table, where) => { const answer = await remove(table, where); return answer.ok ? { ok: true, count: null } : answer; };
    expect(await prune(client, now)).toContain('some jev_calls, some match_events, some level_progress rows, and some keep_awake rows.');
  });

  it('fails the prune when Supabase refuses', async () => {
    const client = stubClient();
    client.refuse({ ok: false, status: 503, message: 'paused' });
    await expect(prune(client, now)).rejects.toThrow('Supabase refused the read of old matches: 503 paused');
  });

  it('inserts one keep_awake row a run', async () => {
    const client = stubClient();
    expect(await keepAwake(client, now)).toBe('Inserted the keep-awake row at 2027-01-01T12:00:00.000Z.');
    expect(client.tables.keep_awake).toEqual([{ at: '2027-01-01T12:00:00.000Z' }]);
    client.refuse({ ok: false, status: 0, message: 'fetch failed' });
    await expect(keepAwake(client, now)).rejects.toThrow('Supabase refused the keep-awake insert: no answer fetch failed');
  });

  it('passes the pause check when the project answers, and fails it with the dashboard link when not', async () => {
    const client = stubClient();
    expect(await checkAwake(client, 'https://abcd1234.supabase.co')).toBe('Supabase answered the pause check.');
    client.refuse({ ok: false, status: 540, message: 'project paused' });
    await expect(checkAwake(client, 'https://abcd1234.supabase.co')).rejects.toThrow('540 project paused. A paused Free project takes no writes until you press Resume project at https://supabase.com/dashboard/project/abcd1234');
    await expect(checkAwake(client, 'https://db.example.com')).rejects.toThrow('Resume project at supabase.com/dashboard');
    expect(projectRef('https://abcd1234.supabase.co/')).toBe('abcd1234');
    expect(projectRef('https://abcd1234.supabase.co.evil.com')).toBeNull();
  });

  // What the job does on a fork, or before the project exists.
  it('does nothing, in one line a step, with SUPABASE_URL unset', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const env = { ...process.env, SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' };
    for (const step of ['check', 'awake', 'prune']) {
      const out = execFileSync(`${root}node_modules/.bin/tsx`, ['packages/cli/src/weekly.ts', step], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
      expect(out).toBe(`SUPABASE_URL is not set, so the ${step} step does nothing.\n`);
    }
  }, 20_000);
});
