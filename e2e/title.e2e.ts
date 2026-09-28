import { expect, openTitle, test } from './fixtures.ts';

test('the title screen names the stand-in and shows the data notice', async ({ page, shot }) => {
  await openTitle(page);
  await expect(page.getByRole('heading', { name: 'BrickArena' })).toBeVisible();
  // Debug mode says so for as long as the page is open.
  await expect(page.getByRole('status').filter({ hasText: 'DEBUG · stand-in' })).toBeVisible();

  const notice = page.locator('.notice');
  await expect(notice).toContainText('This game records how each match plays, using PostHog and Supabase, and never who you are.');
  await expect(notice.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy.html');
  await expect(notice.getByRole('button', { name: 'Opt out' })).toBeVisible();
  await shot('notice');
});
