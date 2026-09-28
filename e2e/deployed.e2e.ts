import { createServer, type Server } from 'node:http';
import type { Request } from '@playwright/test';
import { smokeSite } from '../packages/cli/src/smoke-site.ts';
import { healthRequest, type SystemOneRequest } from '../packages/jev/src/wire.ts';
import { DEPLOYED_KEY, DEPLOYED_URL, FAKE_TYPESAFE_PORT } from './servers.ts';
import { expect, read, test } from './fixtures.ts';

// The screen a stranger sees first, as Render serves it (e2e/deployed.ts): no
// debug, and a Jev link that works. TypeSafe is this fake, which keeps every
// call that reaches it and answers each with its first option and no stand-in
// mark, as live Jev does. Nothing here is Jev.
type Call = { authorization: string | undefined; ask: SystemOneRequest };
const calls: Call[] = [];
let fake: Server;

test.beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const ask = JSON.parse(body) as SystemOneRequest;
      calls.push({ authorization: req.headers.authorization, ask });
      const [choice] = Object.keys(ask.questions.decision.criteria);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: ask.model, answers: { decision: { type: 'choice', choice } } }));
    });
  });
  await new Promise<void>(done => fake.listen(FAKE_TYPESAFE_PORT, '127.0.0.1', done));
});
test.afterAll(() => new Promise<void>(done => { fake.closeAllConnections(); fake.close(() => done()); }));
test.use({ baseURL: DEPLOYED_URL });

const HEALTH = healthRequest('any').questions.decision.instructions;
const gameAsks = () => calls.filter(call => call.ask.questions.decision.instructions !== HEALTH);

test('the deployed title screen names live Jev, shows the data notice, and its match asks the fake', async ({ page, shot }) => {
  const elsewhere: string[] = [];
  page.on('request', (request: Request) => { if (!request.url().startsWith(DEPLOYED_URL)) elsewhere.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'BrickArena' })).toBeVisible();
  await expect(page.locator('.link')).toHaveText(/^Jev is online · \d+ ms to answer$/);
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  // No debug mode, so nothing says DEBUG or names the stand-in.
  await expect(page.locator('body')).not.toContainText('DEBUG');
  await expect(page.locator('body')).not.toContainText(/stand-in/i);
  // The title screen's check reached the fake, with the JEV_API_KEY secret.
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(call => call.authorization === `Bearer ${DEPLOYED_KEY}`)).toBe(true);

  const notice = page.locator('.notice');
  await expect(notice).toContainText('This game records how each match plays, using PostHog and Supabase, and never who you are.');
  await expect(notice.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy.html');
  await expect(notice.getByRole('button', { name: 'Opt out' })).toBeVisible();
  await shot('title-deployed');

  await notice.getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL('/privacy.html');
  await expect(page).toHaveTitle('Brick Arena privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Brick Arena' }).click();
  await expect(page.locator('.link')).toHaveText(/^Jev is online/);

  // A match, to Jev's first ask: it reaches the fake, and the page counts a
  // live answer and none from the stand-in.
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { name: 'Multi-hit rows' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await read(page)).phase).toBe('playing');
  await page.keyboard.press('Space');
  await expect.poll(() => gameAsks().length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(gameAsks()[0].authorization).toBe(`Bearer ${DEPLOYED_KEY}`);
  await expect.poll(async () => (await read(page)).stats.answeredBy.live, { timeout: 10_000 }).toBeGreaterThan(0);
  const now = await read(page);
  expect(now).toMatchObject({ debug: false, opponent: 'live' });
  expect(now.stats.answeredBy['stand-in']).toBe(0);
  // PostHog is off in Render's build, so the page talks to its own server only.
  expect(elsewhere).toEqual([]);
});

// The check run after each deploy passes here, before one.
test('smoke:site passes on the deployed server', async () => {
  const lines: string[] = [];
  expect(await smokeSite(DEPLOYED_URL, line => lines.push(line))).toBe(true);
  expect(lines).toContainEqual(expect.stringMatching(/^ok {4}\/ shows the title screen: "Jev is online · \d+ ms to answer"$/));
  expect(lines.filter(line => line.startsWith('ok'))).toHaveLength(5);
  expect(lines.at(-1)).toBe('every check passed');
});
