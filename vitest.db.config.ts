import { defineConfig } from 'vitest/config';

// `pnpm test:db`: the Supabase path against a real Postgres and PostgREST
// (supabase/local/compose.yml), kept out of `pnpm test`, which reaches nothing.
export default defineConfig({
  test: {
    include: ['packages/**/*.db.ts'],
    globalSetup: ['packages/cli/src/supabase-local.ts'],
    // One database, so one file at a time.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
