import { expect, test } from './fixtures.ts';

test('the down page shows when the stand-in is stopped, and the game returns with it', async ({ page, standIn, shot }) => {
  await standIn.stop();
  try {
    await page.goto('/');
    const down = page.getByRole('alert');
    await expect(down.getByRole('heading', { name: 'The game is down right now' })).toBeVisible();
    await expect(down).toContainText("Jev can't be reached at the moment");
    // No board and no title screen behind it.
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0);
  } finally {
    await standIn.start();
  }
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByText('Debug: the stand-in answered, not Jev')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();

  await standIn.stop();
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'The game is down right now' })).toBeVisible();
    await shot('down');
  } finally {
    await standIn.start();
  }
});
