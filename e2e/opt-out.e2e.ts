import type { Page, Request } from '@playwright/test';
import { DEV_URL, HOSTED_URL, POSTHOG_HOST } from './servers.ts';
import { expect, openTitle, read, test } from './fixtures.ts';

// consent.ts's OPT_OUT_KEY, which the title screen's button sets.
const OPT_OUT_KEY = 'brick-arena:opt-out';
// Past two of match-log.ts's FLUSH_MS, and PostHog's own batching.
const QUIET_MS = 12_000;

const matchWrite = (request: Request) => request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/matches/');

function watch(page: Page) {
  const seen: Request[] = [];
  page.on('request', request => seen.push(request));
  return seen;
}

test.describe('debug play on the dev server', () => {
  test('a match sends its record while the player records', async ({ page }) => {
    await openTitle(page);
    const write = page.waitForRequest(matchWrite, { timeout: QUIET_MS });
    await page.keyboard.press('Enter');
    const body = (await write).postData() ?? '';
    expect(JSON.parse(body.split('\n')[0])).toMatchObject({ type: 'start', opponent: 'stand-in', debug: true });
  });

  test('opting out is remembered, and a match then sends nothing', async ({ page, shot }) => {
    await openTitle(page);
    await page.locator('.notice').getByRole('button', { name: 'Opt out' }).click();
    await expect(page.locator('.notice')).toContainText('You opted out: this browser records nothing.');
    expect(await page.evaluate(key => localStorage.getItem(key), OPT_OUT_KEY)).toBe('1');

    // consent.ts reads it on the next load.
    await openTitle(page);
    await expect(page.locator('.notice')).toContainText('You opted out');
    await expect(page.locator('.notice').getByRole('button', { name: 'Opt back in' })).toBeVisible();

    const seen = watch(page);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await read(page)).phase, { timeout: 5_000 }).toBe('playing');
    await page.waitForTimeout(QUIET_MS);
    const now = await read(page);
    expect(now.phase).toBe('playing');
    expect(now.matchId).toBeNull();
    expect(seen.filter(matchWrite).map(r => r.url())).toEqual([]);
    // Jev's calls and the page's own files; nothing to any other origin.
    expect(seen.map(r => r.url()).filter(url => !url.startsWith(DEV_URL))).toEqual([]);
    await shot('board');
  });
});

// Debug play sends PostHog nothing whatever the choice, so the opt-out's hold
// on analytics is shown on the built page, which has PostHog on. It has no key,
// so it shows the down page, which still sends `session_started`.
test.describe('the built page with PostHog on', () => {
  async function posthogCalls(page: Page) {
    // posthog-js drops every event from a browser that says it is automated
    // or headless, so without this both specs would pass with PostHog silent.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
    });
    const calls: string[] = [];
    await page.route(`${POSTHOG_HOST}/**`, route => {
      calls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' });
    });
    return calls;
  }

  test('sends PostHog its events while the player records', async ({ page }) => {
    const calls = await posthogCalls(page);
    await page.goto(HOSTED_URL);
    await expect(page.getByRole('heading', { name: 'The game is down right now' })).toBeVisible();
    await expect.poll(() => calls.length, { timeout: QUIET_MS }).toBeGreaterThan(0);
  });

  test('sends PostHog nothing once the player has opted out', async ({ page, shot }) => {
    const calls = await posthogCalls(page);
    await page.addInitScript(key => localStorage.setItem(key, '1'), OPT_OUT_KEY);
    const seen = watch(page);
    await page.goto(HOSTED_URL);
    await expect(page.getByRole('heading', { name: 'The game is down right now' })).toBeVisible();
    await page.waitForTimeout(QUIET_MS);
    expect(calls).toEqual([]);
    expect(seen.map(r => r.url()).filter(url => !url.startsWith(HOSTED_URL))).toEqual([]);
    await shot('down-opted-out');
  });
});
