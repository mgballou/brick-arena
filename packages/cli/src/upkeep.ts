import type { TableClient, TableName } from '../../server/src/supabase.ts';

// The weekly job's three steps (.github/workflows/supabase-weekly.yml,
// docs/specs/data-collection.md, "The catch"). A Free project is paused after a
// week without enough database activity, and only Matthew can resume it, from
// the dashboard. So each week the job checks the project answers and fails
// loudly if not, inserts one row, and deletes the full rows of matches older
// than 90 days, which by then are in a monthly export (`pnpm export`).

export const KEEP_DAYS = 90;
const DAY = 86_400_000;
// Match ids in one delete's `in (…)` filter, which keeps its URL near 3 KB.
const CHUNK = 100;
// Everything but `matches`, which keeps its tally for good.
const PRUNED: TableName[] = ['jev_calls', 'match_events', 'level_progress'];

// `abcd1234` from `https://abcd1234.supabase.co`, for the dashboard link.
export const projectRef = (url: string) => /^https?:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.trim())?.[1] ?? null;

const refused = (what: string, answer: { status: number; message: string }) => `${what}: ${answer.status || 'no answer'} ${answer.message}`.trim();

// The step fails, with a line that says what to do, when the project doesn't answer.
export async function checkAwake(client: TableClient, url: string): Promise<string> {
  const answer = await client.select('matches', { columns: ['id'], order: [['id', 'asc']], limit: 1 });
  if (answer.ok) return 'Supabase answered the pause check.';
  const ref = projectRef(url);
  throw new Error(`${refused('Supabase did not answer the pause check', answer)}. A paused Free project takes no writes until you press Resume project at ${ref ? `https://supabase.com/dashboard/project/${ref}` : 'supabase.com/dashboard'}; after 90 days paused it can no longer be resumed.`);
}

export async function keepAwake(client: TableClient, now = new Date()): Promise<string> {
  const at = now.toISOString();
  const answer = await client.upsert('keep_awake', [{ at }]);
  if (!answer.ok) throw new Error(refused('Supabase refused the keep-awake insert', answer));
  return `Inserted the keep-awake row at ${at}.`;
}

export async function prune(client: TableClient, now = new Date()): Promise<string> {
  const before = new Date(now.getTime() - KEEP_DAYS * DAY).toISOString();
  const old = await client.select('matches', { columns: ['id'], where: [['started_at', 'lt', before]], order: [['id', 'asc']] });
  if (!old.ok) throw new Error(refused('Supabase refused the read of old matches', old));
  const ids = old.rows.map(row => row.id as string);
  const counts: Array<number | null> = [];
  for (const table of PRUNED) {
    let count: number | null = 0;
    for (let at = 0; at < ids.length; at += CHUNK) {
      const answer = await client.remove(table, [['match_id', 'in', ids.slice(at, at + CHUNK)]]);
      if (!answer.ok) throw new Error(refused(`Supabase refused the prune of ${table}`, answer));
      count = count === null || answer.count === null ? null : count + answer.count;
    }
    counts.push(count);
  }
  const awake = await client.remove('keep_awake', [['at', 'lt', before]]);
  if (!awake.ok) throw new Error(refused('Supabase refused the prune of keep_awake', awake));
  const said = (count: number | null) => count ?? 'some';
  return `Pruned matches begun before ${before} (${ids.length} kept in matches): ${PRUNED.map((table, index) => `${said(counts[index])} ${table}`).join(', ')} rows, and ${said(awake.count)} keep_awake rows.`;
}
