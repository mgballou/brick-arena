import { expect, openTitle, test } from './fixtures.ts';

test("the notice's Privacy link opens the privacy page", async ({ page, shot }) => {
  await openTitle(page);
  await page.locator('.notice').getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL('/privacy.html');
  await expect(page).toHaveTitle('Brick Arena privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What is recorded' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to Brick Arena' }).click();
  await expect(page.getByText('Debug: the stand-in answered, not Jev')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/privacy.html');
  await shot('privacy');
});
