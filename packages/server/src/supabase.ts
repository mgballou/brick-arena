// The one door from the game server to Supabase (docs/specs/data-collection.md):
// upserts into the four tables of supabase/migrations/, and nothing else. The
// secret key is the host's SUPABASE_SECRET_KEY, read here and nowhere else; it
// never reaches a log, a record or the page.
//
// Writes are off unless SUPABASE_WRITES=1. With it on, SUPABASE_URL and the key
// choose the real client; tests use the stub, which keeps its calls in memory.

export type TableName = 'matches' | 'jev_calls' | 'match_events' | 'level_progress';
// Each table's primary key, which an upsert matches on.
export const CONFLICT: Record<TableName, string> = {
  matches: 'id',
  jev_calls: 'match_id,n',
  match_events: 'match_id,n',
  level_progress: 'match_id,level',
};

export type Row = Record<string, unknown>;
// `status` 0: no answer at all (the network, or a timeout).
export type UpsertResult = { ok: true } | { ok: false; status: number; message: string };
export type RowClient = { upsert: (table: TableName, rows: Row[]) => Promise<UpsertResult> };

export type StubClient = RowClient & {
  calls: Array<{ table: TableName; rows: Row[] }>;
  // What the next writes answer, until set back to null.
  refuse: (result: Extract<UpsertResult, { ok: false }> | null) => void;
};

export function stubClient(): StubClient {
  const calls: StubClient['calls'] = [];
  let refusal: Extract<UpsertResult, { ok: false }> | null = null;
  return {
    calls,
    refuse: result => { refusal = result; },
    async upsert(table, rows) {
      if (refusal) return refusal;
      calls.push({ table, rows: structuredClone(rows) });
      return { ok: true };
    },
  };
}

// Supabase's Data API (PostgREST): a POST with `on_conflict` and
// `resolution=merge-duplicates` is an upsert. A secret key goes on `apikey`
// alone, since it is not a JWT (supabase.com/docs/guides/api/api-keys).
export function restClient(options: { url: string; key: string; fetch?: typeof fetch; timeoutMs?: number }): RowClient {
  const send = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');
  return {
    async upsert(table, rows) {
      try {
        const response = await send(`${base}/rest/v1/${table}?on_conflict=${CONFLICT[table]}`, {
          method: 'POST',
          headers: { apikey: options.key, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        if (response.ok) return { ok: true };
        return { ok: false, status: response.status, message: (await response.text()).slice(0, 300) };
      } catch (error) {
        return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// The client the server writes with, or null when writes are off. Both the
// flag and SUPABASE_URL must be set; the key must be too.
export function clientFromEnv(env: Record<string, string | undefined>, log: (line: string) => void): RowClient | null {
  if (env.SUPABASE_WRITES?.trim() !== '1') return null;
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) {
    log(`SUPABASE_WRITES is on but ${!url ? 'SUPABASE_URL' : 'SUPABASE_SECRET_KEY'} is not set, so no rows are written`);
    return null;
  }
  return restClient({ url, key });
}
