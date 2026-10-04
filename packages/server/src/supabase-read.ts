import { RECORD_VERSION, summarize, tallyJev, type JevTally, type MatchLine, type MatchSummary } from './record.ts';
import type { Query, Row, TableClient, TableName } from './supabase.ts';

// Rebuild match records from the rows packages/server/src/rows.ts writes.
// Row order within a level follows frame, with level and levelEnd at the edges.
const CHUNK = 20;

export async function rowsOf(client: TableClient, table: TableName, query: Query): Promise<Row[]> {
  const answer = await client.select(table, query);
  if (!answer.ok) throw new Error(`Supabase refused a read of ${table}: ${answer.status || 'no answer'} ${answer.message}`.trim());
  return answer.rows;
}

const iso = (value: unknown) => new Date(value as string).toISOString();

export function linesOf(match: Row, events: Row[], calls: Row[], progress: Row[]): MatchLine[] {
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

export async function* withRows(client: TableClient, matches: Row[], tables: { calls: boolean; progress: boolean }) {
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

export async function matchRecord(client: TableClient, id: string): Promise<{ lines: MatchLine[]; tally: JevTally } | null> {
  const [match] = await rowsOf(client, 'matches', { where: [['id', 'eq', id]], order: [['id', 'asc']], limit: 1 });
  if (!match) return null;
  for await (const rows of withRows(client, [match], { calls: true, progress: true })) {
    const lines = linesOf(rows.match, rows.events, rows.calls, rows.progress);
    return { lines, tally: match.jev_tally as JevTally | null ?? tallyJev(lines) };
  }
  return null;
}

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
