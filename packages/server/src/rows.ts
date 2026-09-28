import { MATCHES_DEFAULTS } from './matches.ts';
import { foldSummary, startSummary, type MatchLine, type MatchSummary } from './record.ts';
import type { Row, RowClient, TableName } from './supabase.ts';

// Each match's record as rows in Supabase (supabase/migrations/), written by
// the game server after the match store has taken the lines, so every check of
// matches.ts runs first. A match against the stand-in, or in debug mode, sends
// nothing (docs/specs/data-collection.md, decision 4).
//
// Rows go out after the browser has its answer, one table at a time and in
// order. A write Supabase refuses stays in memory, up to one match's worth, and
// goes again on the next write or after `retryMs`; a row Postgres can never
// take (a bad value, say) is logged and dropped so it can't hold up the rest.
// Every write is an upsert on the table's key, so sending one twice is safe.
//
// What a restart loses: the count of rows each open match has sent, so lines
// for a match begun before it are not written.

export const ROWS_DEFAULTS = {
  // One match at its size limit.
  maxPendingBytes: MATCHES_DEFAULTS.maxMatchBytes,
  retryMs: 30_000,
  // Matches whose `end` never came are forgotten, oldest first, past this.
  openMatches: 100,
} as const;

// Postgres refused the rows themselves: sending them again can't help.
const LASTING = new Set([400, 409, 413, 422]);

type Op = { table: TableName; match: string; rows: Row[]; bytes: number; key?: string };
type Open = { row: Row; summary: MatchSummary; jev: number; events: number; progress: Map<number, unknown[]> };

export type RowWriter = {
  take: (id: string, lines: MatchLine[]) => void;
  // Settles when everything waiting has gone, or a write has been refused.
  flush: () => Promise<void>;
  pendingBytes: () => number;
};

export function createRowWriter(client: RowClient, options: { build?: string | null; log?: (line: string) => void; maxPendingBytes?: number; retryMs?: number; openMatches?: number } = {}): RowWriter {
  const log = options.log ?? (line => console.error(`[supabase] ${line}`));
  const maxPendingBytes = options.maxPendingBytes ?? ROWS_DEFAULTS.maxPendingBytes;
  const open = new Map<string, Open>();
  const queue: Op[] = [];
  let pending = 0;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The last refusal, while writes are failing.
  let failing: string | null = null;

  const enqueue = (op: Op) => {
    // The match row and a level's progress are whole each time, so a newer one
    // replaces one still waiting, in its place, so the match row stays first.
    const same = op.key ? queue.find(waiting => waiting.key === op.key) : undefined;
    if (same) {
      pending += op.bytes - same.bytes;
      Object.assign(same, { rows: op.rows, bytes: op.bytes });
    } else {
      queue.push(op);
      pending += op.bytes;
    }
  };

  // Past the limit the oldest go first, all but the match rows: they are small,
  // and without one every row after it would point at no match.
  const trim = () => {
    let dropped = 0;
    let oldest: number;
    while (pending > maxPendingBytes && (oldest = queue.findIndex(op => op.table !== 'matches')) >= 0) {
      const [op] = queue.splice(oldest, 1);
      pending -= op.bytes;
      dropped += op.rows.length;
    }
    if (dropped) log(`dropped ${dropped} waiting rows, past ${maxPendingBytes} bytes`);
  };

  const drain = async () => {
    while (queue.length) {
      const op = queue.shift()!;
      pending -= op.bytes;
      const result = await client.upsert(op.table, op.rows);
      if (result.ok) {
        if (failing) log('writes go through again');
        failing = null;
        continue;
      }
      const why = `${result.status || 'no answer'} ${result.message}`.trim();
      if (LASTING.has(result.status)) {
        log(`refused ${op.rows.length} ${op.table} rows of ${op.match}, dropped: ${why}`);
        continue;
      }
      // Back at the head, with the newest of its rows if one came meanwhile.
      const newer = op.key ? queue.findIndex(waiting => waiting.key === op.key) : -1;
      if (newer >= 0) Object.assign(op, queue.splice(newer, 1)[0]);
      else pending += op.bytes;
      queue.unshift(op);
      trim();
      if (why !== failing) log(`refused ${op.rows.length} ${op.table} rows of ${op.match}, kept to retry: ${why}`);
      failing = why;
      timer ??= setTimeout(() => {
        timer = null;
        void flush();
      }, options.retryMs ?? ROWS_DEFAULTS.retryMs);
      timer.unref?.();
      return;
    }
  };

  const flush = () => running ??= drain()
    .catch(error => log(`write failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => { running = null; });

  // Called inside the store's write, so it must never throw into it.
  const take = (id: string, lines: MatchLine[]) => {
    try {
      queueRows(id, lines);
    } catch (error) {
      log(`could not turn ${id}'s lines into rows: ${error instanceof Error ? error.message : String(error)}`);
    }
    void flush();
  };

  const queueRows = (id: string, lines: MatchLine[]) => {
    let match = open.get(id);
    if (!match) {
      const start = lines[0];
      if (start?.type !== 'start' || start.opponent !== 'live' || start.debug) return;
      match = { row: matchRow(start, options.build ?? null), summary: startSummary(start), jev: 0, events: 0, progress: new Map() };
      open.set(id, match);
      if (open.size > (options.openMatches ?? ROWS_DEFAULTS.openMatches)) open.delete(open.keys().next().value!);
    }
    const ops = rowsOf(id, match, lines);
    for (const op of ops) enqueue(op);
    if (lines.some(line => line.type === 'end')) open.delete(id);
    trim();
  };

  return { take, flush, pendingBytes: () => pending };
}

const matchRow = (start: Extract<MatchLine, { type: 'start' }>, build: string | null): Row => ({
  id: start.id,
  app: 'brick-arena',
  started_at: start.at,
  ended_at: null,
  seed: start.seed,
  tuning: start.tuning,
  opponent: start.opponent,
  end_reason: null,
  score_you: null,
  score_jev: null,
  jev_tally: null,
  build,
});

// One write's lines as upserts, the match row first so the rest have a match
// to point at.
function rowsOf(id: string, match: Open, lines: MatchLine[]): Op[] {
  const events: Row[] = [];
  const calls: Row[] = [];
  const levels = new Set<number>();
  for (const line of lines) {
    foldSummary(match.summary, line);
    switch (line.type) {
      case 'start':
        break;
      case 'end':
        Object.assign(match.row, { ended_at: line.at, end_reason: line.reason, score_you: line.human, score_jev: line.jev });
        break;
      case 'progress': {
        const samples = match.progress.get(line.level) ?? [];
        samples.push([line.frame, line.human, line.jev]);
        match.progress.set(line.level, samples);
        levels.add(line.level);
        break;
      }
      case 'jev':
        calls.push({ match_id: id, n: match.jev++, level: line.level, frame: line.frame, tick: line.tick, lead: line.lead, question: line.question, options: line.options, choice: line.choice ?? null, outcome: line.outcome, answer_ms: Math.round(line.ms), state: line.state });
        break;
      default: {
        // level, launch, lost, levelEnd: the rest of the line is its data.
        const { type, level, frame = null, ...data } = line as Extract<MatchLine, { type: 'level' | 'launch' | 'lost' | 'levelEnd' }> & { frame?: number };
        events.push({ match_id: id, n: match.events++, type, level, frame, data });
      }
    }
  }
  const op = (table: TableName, rows: Row[], key?: string): Op => ({ table, match: id, rows, bytes: JSON.stringify(rows).length, key });
  const ops = [op('matches', [{ ...match.row, jev_tally: structuredClone(match.summary.jev) }], `matches:${id}`)];
  if (events.length) ops.push(op('match_events', events));
  if (calls.length) ops.push(op('jev_calls', calls));
  for (const level of levels) ops.push(op('level_progress', [{ match_id: id, level, samples: [...match.progress.get(level)!] }], `level_progress:${id}:${level}`));
  return ops;
}
