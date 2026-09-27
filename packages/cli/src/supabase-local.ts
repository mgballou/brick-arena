import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The stack of supabase/local/compose.yml, for `pnpm test:db`: Postgres on
// 54322 and the Data API on 54321, behind a gateway that takes these two keys
// as Supabase takes a project's (supabase/local/gateway.conf). They are fixed,
// public and good for nothing else.
export const LOCAL = {
  url: 'http://127.0.0.1:54321',
  db: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  secretKey: 'sb_secret_brick_arena_local',
  publishableKey: 'sb_publishable_brick_arena_local',
} as const;

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

export const psql = (args: string[]) => execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', LOCAL.db, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });

// Vitest's global setup: an empty schema, Supabase's roles, every migration in
// order, and a Data API that has seen the tables they made.
export default async function setup() {
  try {
    psql(['-c', 'select 1']);
  } catch (error) {
    throw new Error(`No Postgres answers at ${LOCAL.db}. Start the stack with \`pnpm db:up\` (supabase/local/compose.yml).\n${error instanceof Error ? error.message : String(error)}`);
  }
  const migrations = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort();
  psql([
    '-c', 'drop schema if exists public cascade',
    '-c', 'create schema public',
    '-f', join(ROOT, 'supabase', 'local', 'roles.sql'),
    ...migrations.flatMap(name => ['-f', join(MIGRATIONS, name)]),
    '-c', "notify pgrst, 'reload schema'",
  ]);
  console.log(`Applied ${migrations.join(', ')} to a new public schema.`);

  // PostgREST reloads its schema cache on the notify, a moment later. The
  // weekly job's table comes from the last migration.
  const deadline = Date.now() + 30_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`${LOCAL.url}/rest/v1/keep_awake?select=at&limit=0`, { headers: { apikey: LOCAL.secretKey } });
      if (answer.ok) return;
      last = `${answer.status} ${await answer.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(`The Data API at ${LOCAL.url} never saw the migrations' tables: ${last}. Is \`pnpm db:up\` running?`);
}
