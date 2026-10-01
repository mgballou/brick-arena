import { expect, openTitle, playLevel, read, test } from './fixtures.ts';

// A level lasts at most its 90 s clock, after a 3 s countdown and the banner.
test('level 1 plays to a result against the stand-in', async ({ page, shot }) => {
  test.setTimeout(180_000);
  await openTitle(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Multi-hit rows' })).toBeVisible();

  const end = await playLevel(page, 150_000);
  expect(end.results).toHaveLength(1);
  const [result] = end.results;
  expect(result.level).toBe(0);
  expect(end.opponent).toBe('stand-in');

  const banner = { human: 'You take it', jev: 'Stand-in takes it', tie: 'Dead even' }[result.winner];
  await expect(page.getByRole('heading', { name: banner })).toBeVisible();
  await expect(page.locator('.tally .human b')).toHaveText(String(result.human));
  await expect(page.locator('.tally .jev b')).toHaveText(String(result.jev));
  await expect(page.getByText('Space for level 2')).toBeVisible();
  // Still named a debug match against the stand-in.
  await expect(page.getByRole('status').filter({ hasText: 'DEBUG · stand-in' })).toBeVisible();
  expect((await read(page)).phase).toBe('levelEnd');
  await shot('result');
});
