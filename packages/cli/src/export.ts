import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { tableClientFromEnv } from '../../server/src/supabase.ts';
import { exportMonth, lastMonth, monthRange } from './supabase-read.ts';

// A month of match records out of Supabase, as one gzipped NDJSON file of
// record version 1 lines (packages/server/src/record.ts). The Free plan keeps
// no backups, so this file is the backup; run it each month, before the weekly
// job's 90-day prune reaches the month.
//
//   pnpm export                      last month, into BRICK_ARENA_EXPORT_DIR or ~/brick-arena-exports
//   pnpm export --month 2026-10 --out <dir>
//   pnpm export --month 2026-10 --force   replace a file already there
//
// Reads with SUPABASE_URL and SUPABASE_SECRET_KEY from the shell.
const DEFAULT_EXPORT_DIR = join(homedir(), 'brick-arena-exports');

const { values } = parseArgs({
  options: {
    month: { type: 'string' },
    out: { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

try {
  const client = tableClientFromEnv(process.env);
  if (!client) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY to the project\'s to export from it.');
  const month = values.month ?? lastMonth();
  const dir = values.out ?? (process.env.BRICK_ARENA_EXPORT_DIR?.trim() || DEFAULT_EXPORT_DIR);
  if (Date.parse(monthRange(month).to) > Date.now()) console.log(`${month} is not over, so matches begun after now are not in this file.`);
  const result = await exportMonth(client, { month, dir, force: values.force });
  console.log(`Wrote ${result.lines} lines of ${result.matches} matches begun in ${month} (UTC) to ${result.path}.`);
  if (result.pruned.length) console.log(`${result.pruned.length} of them had been pruned and hold only the match row: ${result.pruned.join(', ')}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
