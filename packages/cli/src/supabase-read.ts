import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { linesOf, rowsOf, withRows } from '../../server/src/supabase-read.ts';
import type { TableClient } from '../../server/src/supabase.ts';

export { linesOf, matchRecord, recentMatches } from '../../server/src/supabase-read.ts';

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
