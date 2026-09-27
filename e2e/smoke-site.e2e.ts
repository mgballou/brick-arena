import { smokeSite } from '../packages/cli/src/smoke-site.ts';
import { DEV_URL, HOSTED_URL } from './servers.ts';
import { expect, test } from './fixtures.ts';

// `pnpm smoke:site` against both servers: it passes where the title screen
// answers, and names the down page where it doesn't.
test('smoke:site passes on the dev server with the stand-in answering', async () => {
  const lines: string[] = [];
  expect(await smokeSite(DEV_URL, line => lines.push(line))).toBe(true);
  expect(lines.filter(line => line.startsWith('ok'))).toHaveLength(5);
  expect(lines.at(-1)).toBe('every check passed');
});

test('smoke:site fails on a hosted server that cannot reach Jev, and says why', async () => {
  const lines: string[] = [];
  expect(await smokeSite(HOSTED_URL, line => lines.push(line))).toBe(false);
  expect(lines).toContain('ok    /healthz answers "ok"');
  expect(lines).toContain('ok    /privacy.html answers 200 with its Privacy heading');
  expect(lines).toContain('FAIL  / shows the down page: this server cannot reach Jev (the reason is in its log)');
});
