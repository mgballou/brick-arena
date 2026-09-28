// The one door to Supabase (docs/specs/data-collection.md): upserts into the
// tables of supabase/migrations/, and the reads and deletes of `pnpm match`,
// `pnpm export` and `pnpm weekly`. The secret key is SUPABASE_SECRET_KEY, read
// here and nowhere else: the host's for the game server, a GitHub secret for
// the weekly job, Matthew's shell for the CLIs. It never reaches a log, a
// record or the page.
//
// The server's writes are off unless SUPABASE_WRITES=1. With it on,
// SUPABASE_URL and the key choose the real client; tests use the stub, which
// keeps its calls and its tables in memory.

export type TableName = 'matches' | 'jev_calls' | 'match_events' | 'level_progress' | 'keep_awake';
// Each table's primary key, which an upsert matches on.
export const CONFLICT: Record<TableName, string> = {
  matches: 'id',
  jev_calls: 'match_id,n',
  match_events: 'match_id,n',
  level_progress: 'match_id,level',
  keep_awake: 'at',
};

export type Row = Record<string, unknown>;
// `status` 0: no answer at all (the network, or a timeout).
export type Refusal = { ok: false; status: number; message: string };
export type UpsertResult = { ok: true } | Refusal;
export type RowClient = { upsert: (table: TableName, rows: Row[]) => Promise<UpsertResult> };

// A filter the Data API and the stub both read. `in` takes a list.
export type Where = Array<[column: string, op: 'eq' | 'lt' | 'gte', value: string | number] | [column: string, op: 'in', value: Array<string | number>]>;
export type Query = { columns?: string[]; where?: Where; order: Array<[column: string, direction: 'asc' | 'desc']>; limit?: number };
export type SelectResult = { ok: true; rows: Row[] } | Refusal;
// `count` is null when the answer did not say.
export type RemoveResult = { ok: true; count: number | null } | Refusal;
export type TableClient = RowClient & {
  // Every row that matches, however many pages that takes, unless `limit` says fewer.
  select: (table: TableName, query: Query) => Promise<SelectResult>;
  // Refuses an empty `where`, as Supabase does: a delete names its rows.
  remove: (table: TableName, where: Where) => Promise<RemoveResult>;
};

export type StubClient = TableClient & {
  calls: Array<{ table: TableName; rows: Row[] }>;
  tables: Record<TableName, Row[]>;
  // What the next calls answer, until set back to null.
  refuse: (result: Refusal | null) => void;
};

const matches = (row: Row, where: Where = []) => where.every(([column, op, value]) => {
  const cell = row[column] as string | number;
  if (op === 'in') return (value as Array<string | number>).includes(cell);
  // Timestamps compare as instants, the way Postgres compares them.
  const [a, b] = typeof cell === 'string' && typeof value === 'string' && !Number.isNaN(Date.parse(cell)) && !Number.isNaN(Date.parse(value)) ? [Date.parse(cell), Date.parse(value)] : [cell, value];
  return op === 'eq' ? a === b : op === 'lt' ? a < b : a >= b;
});

const byOrder = (order: Query['order']) => (a: Row, b: Row) => {
  for (const [column, direction] of order) {
    const [x, y] = [a[column] as string | number, b[column] as string | number];
    if (x !== y) return (x < y ? -1 : 1) * (direction === 'desc' ? -1 : 1);
  }
  return 0;
};

export function stubClient(): StubClient {
  const calls: StubClient['calls'] = [];
  const tables: StubClient['tables'] = { matches: [], jev_calls: [], match_events: [], level_progress: [], keep_awake: [] };
  let refusal: Refusal | null = null;
  return {
    calls,
    tables,
    refuse: result => { refusal = result; },
    async upsert(table, rows) {
      if (refusal) return refusal;
      calls.push({ table, rows: structuredClone(rows) });
      const keys = CONFLICT[table].split(',');
      for (const row of structuredClone(rows)) {
        const same = tables[table].find(held => keys.every(key => held[key] === row[key]));
        if (same) Object.assign(same, row);
        else tables[table].push(row);
      }
      return { ok: true };
    },
    async select(table, query) {
      if (refusal) return refusal;
      const rows = tables[table].filter(row => matches(row, query.where)).sort(byOrder(query.order)).slice(0, query.limit);
      return { ok: true, rows: structuredClone(query.columns ? rows.map(row => Object.fromEntries(query.columns!.map(column => [column, row[column]]))) : rows) };
    },
    async remove(table, where) {
      if (refusal) return refusal;
      if (!where.length) return { ok: false, status: 400, message: 'a delete must name its rows' };
      const before = tables[table].length;
      tables[table] = tables[table].filter(row => !matches(row, where));
      return { ok: true, count: before - tables[table].length };
    },
  };
}

// Supabase's Data API (PostgREST): a POST with `on_conflict` and
// `resolution=merge-duplicates` is an upsert. A secret key goes on `apikey`
// alone, since it is not a JWT (supabase.com/docs/guides/api/api-keys).
//
// A read goes a page at a time until a page comes back empty, so it never
// stops short at the server's row cap (1000 on Supabase unless changed), whatever
// that cap is. Every read names an order, so the pages don't overlap.
const PAGE = 1000;

// A value inside `in.(…)`, quoted so a comma or a bracket can't end it.
const quoted = (value: string | number) => typeof value === 'number' ? String(value) : `"${value.replace(/["\\]/g, '\\$&')}"`;
export function filterParams(where: Where = []): string[] {
  return where.map(([column, op, value]) => `${column}=${encodeURIComponent(op === 'in' ? `in.(${value.map(quoted).join(',')})` : `${op}.${value}`)}`);
}

export function restClient(options: { url: string; key: string; fetch?: typeof fetch; timeoutMs?: number }): TableClient {
  const send = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');
  const call = async (path: string, init: { method: string; prefer?: string; body?: string }): Promise<Response | Refusal> => {
    try {
      const response = await send(`${base}/rest/v1/${path}`, {
        method: init.method,
        headers: { apikey: options.key, ...init.body === undefined ? {} : { 'content-type': 'application/json' }, ...init.prefer ? { prefer: init.prefer } : {} },
        body: init.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (response.ok) return response;
      return { ok: false, status: response.status, message: (await response.text()).slice(0, 300) };
    } catch (error) {
      return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    async upsert(table, rows) {
      const answer = await call(`${table}?on_conflict=${CONFLICT[table]}`, { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(rows) });
      return answer instanceof Response ? { ok: true } : answer;
    },
    async select(table, query) {
      const rows: Row[] = [];
      const params = [`select=${query.columns?.join(',') ?? '*'}`, ...filterParams(query.where), `order=${query.order.map(([column, direction]) => `${column}.${direction}`).join(',')}`];
      for (;;) {
        const want = Math.min(PAGE, (query.limit ?? Infinity) - rows.length);
        if (want <= 0) return { ok: true, rows };
        const answer = await call(`${table}?${[...params, `limit=${want}`, `offset=${rows.length}`].join('&')}`, { method: 'GET' });
        if (!(answer instanceof Response)) return answer;
        const page = await answer.json() as Row[];
        if (!page.length) return { ok: true, rows };
        rows.push(...page);
      }
    },
    async remove(table, where) {
      if (!where.length) return { ok: false, status: 400, message: 'a delete must name its rows' };
      const answer = await call(`${table}?${filterParams(where).join('&')}`, { method: 'DELETE', prefer: 'return=minimal,count=exact' });
      if (!(answer instanceof Response)) return answer;
      // `Content-Range: */12` when the Data API counted.
      const count = answer.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
      return { ok: true, count: count === undefined ? null : Number(count) };
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

// The client the CLIs read and prune with: null when SUPABASE_URL is unset, so
// a caller can skip; a thrown error when the URL is set and the key is not.
export function tableClientFromEnv(env: Record<string, string | undefined>): TableClient | null {
  const url = env.SUPABASE_URL?.trim();
  if (!url) return null;
  const key = env.SUPABASE_SECRET_KEY?.trim();
  if (!key) throw new Error('SUPABASE_URL is set but SUPABASE_SECRET_KEY is not');
  return restClient({ url, key, timeoutMs: 30_000 });
}
