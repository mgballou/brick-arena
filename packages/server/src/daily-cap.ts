import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cap, CapLimits } from '../../jev/src/cap.ts';
import { createCap } from '../../jev/src/cap.ts';
import type { TableClient } from './supabase.ts';

const utcDay = () => new Date().toISOString().slice(0, 10);
const fileName = 'jev-calls.json';

type SavedCount = { day: string; count: number };

function readCount(path: string, day: string): number {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as SavedCount;
    return saved.day === day && Number.isSafeInteger(saved.count) && saved.count >= 0 ? saved.count : 0;
  } catch {
    return 0;
  }
}

export function createFileCap(directory: string, limits: CapLimits, today: () => string = utcDay): Cap {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  let day = today();
  let count = readCount(path, day);
  const cap = createCap(limits, today, count);
  return {
    limits,
    take(visitor) {
      const currentDay = today();
      if (currentDay !== day) {
        day = currentDay;
        count = 0;
      }
      const result = cap.take(visitor);
      if (result === 'ok') {
        count++;
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, `${JSON.stringify({ day, count } satisfies SavedCount)}\n`, 'utf8');
        renameSync(temporary, path);
      }
      return result;
    },
  };
}

// Match rows mark when a match began; its jev_calls rows are the persisted
// calls for that UTC day. Both reads page through the full table via TableClient.
export async function supabaseDailyCount(client: TableClient, day: string): Promise<number> {
  const start = `${day}T00:00:00.000Z`;
  const next = `${new Date(Date.parse(start) + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const matches = await client.select('matches', {
    columns: ['id'],
    where: [['started_at', 'gte', start], ['started_at', 'lt', next]],
    order: [['id', 'asc']],
  });
  if (!matches.ok) throw new Error(`could not read today's Jev calls: matches ${matches.status} ${matches.message}`);
  const ids = matches.rows.map(row => row.id).filter((id): id is string => typeof id === 'string');
  if (!ids.length) return 0;
  const calls = await client.select('jev_calls', {
    columns: ['match_id'],
    where: [['match_id', 'in', ids]],
    order: [['match_id', 'asc'], ['n', 'asc']],
  });
  if (!calls.ok) throw new Error(`could not read today's Jev calls: jev_calls ${calls.status} ${calls.message}`);
  return calls.rows.length;
}

export async function createSupabaseCap(client: TableClient, limits: CapLimits, today: () => string = utcDay): Promise<Cap> {
  const day = today();
  return createCap(limits, today, await supabaseDailyCount(client, day));
}

// The Supabase count, or, when Supabase can't be read at boot (paused, or not
// answering), the count kept in `directory`, so the server still starts.
export async function createBootCap(client: TableClient, directory: string, limits: CapLimits, log: (line: string) => void, today: () => string = utcDay): Promise<Cap> {
  try {
    return await createSupabaseCap(client, limits, today);
  } catch (error) {
    log(`${error instanceof Error ? error.message : String(error)}, so the cap counts in ${directory}`);
    return createFileCap(directory, limits, today);
  }
}
