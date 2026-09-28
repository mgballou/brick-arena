import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The servers the browser specs play against. Neither can reach Jev: the dev
// server takes a dummy key file and the stand-in's address, never ~/.jev-key,
// and the hosted one has no key at all (hosted.ts).
export const STAND_IN_PORT = 18797;
// The dev server in debug mode, where the stand-in plays.
export const DEV_URL = 'http://127.0.0.1:5199';
// The built page on the hosted server, with no key, so it shows the down page.
export const HOSTED_URL = 'http://127.0.0.1:5198';
// The built page names this PostHog host; the specs answer it themselves.
export const POSTHOG_HOST = 'https://posthog.e2e.invalid';

// Build output, the dummy key and match records, all out of the repo's way.
export const OUT = fileURLToPath(new URL('./.out', import.meta.url));

export function dummyKeyFile(): string {
  mkdirSync(OUT, { recursive: true });
  const path = `${OUT}/dummy-key`;
  writeFileSync(path, 'dummy\n');
  return path;
}
