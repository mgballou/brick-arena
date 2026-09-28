import { tableClientFromEnv, type TableClient } from '../../server/src/supabase.ts';
import { checkAwake, keepAwake, prune } from './upkeep.ts';

// One step of the weekly Supabase job (packages/cli/src/upkeep.ts):
//
//   pnpm weekly check    fail unless the project answers
//   pnpm weekly awake    insert one keep_awake row
//   pnpm weekly prune    delete the full rows of matches older than 90 days
//
// With SUPABASE_URL unset, as on a fork or a pull request, each step says so in
// one line and does nothing.
const steps: Record<string, (client: TableClient, url: string) => Promise<string>> = {
  check: (client, url) => checkAwake(client, url),
  awake: client => keepAwake(client),
  prune: client => prune(client),
};
const name = process.argv[2] ?? '';
const step = Object.hasOwn(steps, name) ? steps[name] : null;
// On GitHub, a failure also goes on the run's summary page.
const fail = (message: string) => {
  console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error title=Supabase ${name}::${message}` : message);
  process.exitCode = 1;
};

if (!step) {
  fail(`pnpm weekly takes one of ${Object.keys(steps).join(', ')}.`);
} else {
  try {
    const client = tableClientFromEnv(process.env);
    if (!client) console.log(`SUPABASE_URL is not set, so the ${name} step does nothing.`);
    else console.log(await step(client, process.env.SUPABASE_URL!.trim()));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
