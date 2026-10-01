import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { RECORD_VERSION, summarize, tallyJev, type JevTally, type MatchLine, type MatchSummary } from '../../server/src/record.ts';
import type { Query, Row, TableClient, TableName } from '../../server/src/supabase.ts';

// The match record read back out of Supabase (docs/specs/data-collection.md),
// for `pnpm match` and `pnpm export`: the rows packages/server/src/rows.ts
// writes, turned back into record version 1 lines.
//
// What the rows can't give back: the order the browser wrote lines in. Within
// a level they come back by frame (the level line first, `levelEnd` last), and
// at one frame events, then Jev's calls, then progress. A call's `ms` comes
// back whole, as `answer_ms` holds it.

// Match ids in one `in (…)` filter.
const CHUNK = 20;

async function rowsOf(client: TableClient, table: TableName, query: Query): Promise<Row[]> {
  const answer = await client.select(table, query);
  if (!answer.ok) throw new Error(`Supabase refused a read of ${table}: ${answer.status || 'no answer'} ${answer.message}`.trim());
  return answer.rows;
}

// Postgres gives `2026-09-26 15:01:57+00` back as `2026-09-26T15:01:57+00:00`;
// the record says it the way the server wrote it.
const iso = (value: unknown) => new Date(value as string).toISOString();

export function linesOf(match: Row, events: Row[], calls: Row[], progress: Row[]): MatchLine[] {
  // [level, place, frame, kind, line]: place 0 is the level line, 2 is `levelEnd`.
  const body: Array<[number, number, number, number, MatchLine]> = [];
  for (const row of events) {
    const line = { type: row.type, level: row.level, ...row.frame === null ? {} : { frame: row.frame }, ...row.data as object } as MatchLine;
    const place = line.type === 'level' ? 0 : line.type === 'levelEnd' ? 2 : 1;
    body.push([row.level as number, place, (row.frame as number | null) ?? 0, 0, line]);
  }
  for (const row of calls) {
    const line: MatchLine = { type: 'jev', level: row.level as number, frame: row.frame as number, tick: row.tick as number, lead: row.lead as number, question: row.question as 'target', options: row.options as string[], state: row.state as { bricks: string }, outcome: row.outcome as 'answered', ...row.choice === null ? {} : { choice: row.choice as string }, ms: row.answer_ms as number };
    body.push([line.level, 1, line.frame, 1, line]);
  }
  for (const row of progress) {
    for (const [frame, human, jev] of row.samples as Array<[number, never, never]>) body.push([row.level as number, 1, frame, 2, { type: 'progress', level: row.level as number, frame, human, jev }]);
  }
  // A stable sort, so rows keep their order where nothing else tells them apart.
  body.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

  const start: MatchLine = { type: 'start', v: RECORD_VERSION, id: match.id as string, at: iso(match.started_at), seed: match.seed as number, tuning: match.tuning as string, opponent: match.opponent as 'live', debug: false };
  const end: MatchLine[] = match.ended_at === null || match.ended_at === undefined ? [] : [{ type: 'end', at: iso(match.ended_at), reason: match.end_reason as 'final', human: match.score_you as number, jev: match.score_jev as number }];
  return [start, ...body.map(entry => entry[4]), ...end];
}

const byMatch = (rows: Row[]) => {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.match_id as string, [...groups.get(row.match_id as string) ?? [], row]);
  return (id: string) => groups.get(id) ?? [];
};

// Each match's child rows, a few matches to a read.
async function* withRows(client: TableClient, matches: Row[], tables: { calls: boolean; progress: boolean }) {
  for (let at = 0; at < matches.length; at += CHUNK) {
    const chunk = matches.slice(at, at + CHUNK);
    const where: Query['where'] = [['match_id', 'in', chunk.map(match => match.id as string)]];
    const [events, calls, progress] = await Promise.all([
      rowsOf(client, 'match_events', { where, order: [['match_id', 'asc'], ['n', 'asc']] }).then(byMatch),
      tables.calls ? rowsOf(client, 'jev_calls', { where, order: [['match_id', 'asc'], ['n', 'asc']] }).then(byMatch) : () => [],
      tables.progress ? rowsOf(client, 'level_progress', { where, order: [['match_id', 'asc'], ['level', 'asc']] }).then(byMatch) : () => [],
    ]);
    for (const match of chunk) {
      const id = match.id as string;
      yield { match, events: events(id), calls: calls(id), progress: progress(id) };
    }
  }
}

// One match's whole record and Jev's tally, or null when Supabase holds no such
// match. The tally is the match row's, which outlives the calls' rows.
export async function matchRecord(client: TableClient, id: string): Promise<{ lines: MatchLine[]; tally: JevTally } | null> {
  const [match] = await rowsOf(client, 'matches', { where: [['id', 'eq', id]], order: [['id', 'asc']], limit: 1 });
  if (!match) return null;
  for await (const rows of withRows(client, [match], { calls: true, progress: true })) {
    const lines = linesOf(rows.match, rows.events, rows.calls, rows.progress);
    return { lines, tally: match.jev_tally as JevTally | null ?? tallyJev(lines) };
  }
  return null;
}

// The most recent matches, newest first, as `pnpm match` lists them. Jev's
// tally comes from the match row, so the calls themselves are never read, and
// it survives the prune.
export async function recentMatches(client: TableClient, count: number): Promise<MatchSummary[]> {
  const matches = await rowsOf(client, 'matches', { order: [['started_at', 'desc'], ['id', 'desc']], limit: count });
  const summaries: MatchSummary[] = [];
  for await (const rows of withRows(client, matches, { calls: false, progress: false })) {
    const summary = summarize(linesOf(rows.match, rows.events, [], []))!;
    if (rows.match.jev_tally) summary.jev = rows.match.jev_tally as JevTally;
    summaries.push(summary);
  }
  return summaries;
}

// `2026-10` as the instants it runs between, in UTC.
export function monthRange(month: string): { from: string; to: string } {
  const found = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!found) throw new Error(`--month takes a month as YYYY-MM, not ${JSON.stringify(month)}`);
  const [year, index] = [Number(found[1]), Number(found[2]) - 1];
  return { from: new Date(Date.UTC(year, index, 1)).toISOString(), to: new Date(Date.UTC(year, index + 1, 1)).toISOString() };
}

// The last whole month before `now`, in UTC: what a monthly export takes.
export function lastMonth(now = new Date()): string {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return month.toISOString().slice(0, 7);
}

export const exportName = (month: string) => `brick-arena-${month}.ndjson.gz`;

export type ExportResult = { path: string; matches: number; lines: number; pruned: string[] };

// Every match begun in `month` (UTC), one match's lines after another, in one
// gzipped NDJSON file in `dir`. It is the only backup the Free plan has, so it
// never replaces a file already there unless told to: one made after the prune
// would hold less. It is written beside its name and moved into place, so a
// failed export leaves nothing that blocks the next.
export async function exportMonth(client: TableClient, options: { month: string; dir: string; force?: boolean }): Promise<ExportResult> {
  const { from, to } = monthRange(options.month);
  const path = join(options.dir, exportName(options.month));
  if (existsSync(path) && !options.force) throw new Error(`${path} is already there. An export made after the 90-day prune holds less than the first one; pass --force to replace it anyway.`);
  const matches = await rowsOf(client, 'matches', { where: [['started_at', 'gte', from], ['started_at', 'lt', to]], order: [['started_at', 'asc'], ['id', 'asc']] });

  mkdirSync(options.dir, { recursive: true });
  const part = `${path}.part`;
  const gzip = createGzip();
  const file = createWriteStream(part);
  const done = once(file, 'finish');
  // Awaited below; this only stops a write error from going unhandled meanwhile.
  done.catch(() => {});
  gzip.pipe(file);
  const result: ExportResult = { path, matches: matches.length, lines: 0, pruned: [] };
  try {
    for await (const rows of withRows(client, matches, { calls: true, progress: true })) {
      // Every match begins with a level line; a match with no rows at all was pruned.
      if (!rows.events.length && !rows.calls.length && !rows.progress.length) result.pruned.push(rows.match.id as string);
      for (const line of linesOf(rows.match, rows.events, rows.calls, rows.progress)) {
        result.lines++;
        if (!gzip.write(`${JSON.stringify(line)}\n`)) await once(gzip, 'drain');
      }
    }
    gzip.end();
    await done;
  } catch (error) {
    gzip.destroy();
    file.destroy();
    rmSync(part, { force: true });
    throw error;
  }
  renameSync(part, path);
  return result;
}
