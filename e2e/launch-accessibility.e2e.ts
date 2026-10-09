import { expect, openTitle, read, test } from './fixtures.ts';

test('the page publishes a title, description, share card, and reachable favicon', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Brick Arena — You vs. Jev');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /Five levels/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Brick Arena — You vs. Jev');
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /Clear the bricks/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary');
  const image = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(image).toBe('https://brick-arena.onrender.com/mark.svg');
  const icon = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(icon).toBe('/mark.svg');
  const response = await page.request.get(icon!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/svg+xml');
});

test('the title screen has a useful keyboard order and play works without a pointer', async ({ page }) => {
  await openTitle(page);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Start' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Privacy' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Opt out' })).toBeFocused();

  await expect(page.getByRole('button', { name: 'Start' })).toHaveAccessibleName('Start');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Multi-hit rows' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await read(page)).phase).toBe('playing');

  await expect(page.locator('canvas[aria-label="Your board"]')).toHaveCount(1);
  await expect(page.locator('canvas[aria-label="Stand-in\'s board"]')).toHaveCount(1);
  const before = (await read(page)).human.paddle;
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.up('ArrowRight');
  expect((await read(page)).human.paddle).toBeGreaterThan(before);
});

test('the title copy keeps readable text contrast in Chromium', async ({ page }) => {
  await openTitle(page);
  const contrast = await page.locator('.notice').evaluate(element => {
    const foreground = getComputedStyle(element).color.match(/[\d.]+/g)?.map(Number) ?? [];
    const card = element.closest('.card');
    const gradient = card ? getComputedStyle(card).backgroundImage : '';
    const colors = [...gradient.matchAll(/rgb\(([^)]+)\)/g)].map(match => match[1].split(',').map(Number));
    const luminance = (rgb: number[]) => {
      const channels = rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    return colors.map(background => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    });
  });
  expect(contrast.length).toBeGreaterThan(0);
  expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
});
