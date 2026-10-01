import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

// Go-live's check by eye, as a command (docs/go-live.md, the `pnpm smoke:site`
// step under *Secrets*):
//
//   pnpm smoke:site https://<the service>
//
// /healthz answers ok, /privacy.html answers with its heading, and / in
// headless Chromium shows the title screen with Jev online and the data
// notice, whose Privacy link opens the privacy page. Opening / runs the title
// screen's check, one call to Jev, as any visitor's does. PostHog drops events
// from an automated browser, so the run records nothing there, and it starts no
// match. Needs Chromium once: pnpm exec playwright install chromium
const TIMEOUT_MS = 20_000;

export async function smokeSite(site: string, print: (line: string) => void = console.log): Promise<boolean> {
  const base = site.replace(/\/+$/, '');
  let passed = true;
  const check = (ok: boolean, line: string) => { print(`${ok ? 'ok  ' : 'FAIL'}  ${line}`); if (!ok) passed = false; };
  print(`smoke:site ${base}`);

  const health = await get(`${base}/healthz`);
  check(health.status === 200 && health.body.trim() === 'ok', `/healthz answers ${health.status === 200 ? JSON.stringify(health.body.trim().slice(0, 40)) : health.why}`);

  const privacy = await get(`${base}/privacy.html`);
  check(privacy.status === 200 && privacy.body.includes('<h1>Privacy</h1>'), `/privacy.html answers ${privacy.status === 200 ? `200${privacy.body.includes('<h1>Privacy</h1>') ? ' with its Privacy heading' : ', but with no Privacy heading'}` : privacy.why}`);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    check(false, `/ could not be opened: Chromium did not start (pnpm exec playwright install chromium). ${firstLine(error)}`);
    return passed;
  }
  try {
    const page = await browser.newPage({ colorScheme: 'dark' });
    await page.goto(`${base}/`, { timeout: TIMEOUT_MS });
    const title = page.locator('.notice');
    const down = page.getByRole('heading', { name: 'The game is down right now' });
    await title.or(down).first().waitFor({ timeout: TIMEOUT_MS }).catch(() => undefined);
    if (await down.isVisible()) {
      check(false, '/ shows the down page: this server cannot reach Jev (the reason is in its log)');
    } else if (!await title.isVisible()) {
      check(false, `/ shows neither the title screen nor the down page after ${TIMEOUT_MS / 1000} s`);
    } else {
      await titleScreen(page, check);
    }
  } catch (error) {
    check(false, `/ could not be read: ${firstLine(error)}`);
  } finally {
    await browser.close();
  }
  print(passed ? 'every check passed' : 'a check failed');
  return passed;
}

async function titleScreen(page: Page, check: (ok: boolean, line: string) => void) {
  // The line under the legend says who answered the title screen's check.
  const jev = page.locator('.link');
  await jev.first().waitFor({ timeout: TIMEOUT_MS }).catch(() => undefined);
  await page.locator('.link.checking').waitFor({ state: 'hidden', timeout: TIMEOUT_MS }).catch(() => undefined);
  const refused = page.locator('.no-jev');
  if (await refused.isVisible()) {
    check(false, `/ shows the title screen, but Jev isn't reachable: ${(await refused.locator('.why').textContent())?.trim()}`);
  } else {
    const said = (await jev.textContent().catch(() => null))?.trim() ?? '';
    const live = said.startsWith('Jev is online');
    // Only the dev server in debug mode lets the stand-in answer.
    const standIn = said.startsWith('Debug: the stand-in answered');
    check(live || standIn, `/ shows the title screen: "${said || 'no word from Jev'}"${standIn ? ' (debug mode, not the hosted service)' : ''}`);
  }

  const notice = page.locator('.notice');
  const text = (await notice.textContent())?.trim() ?? '';
  const link = notice.getByRole('link', { name: 'Privacy' });
  const href = await link.getAttribute('href').catch(() => null);
  check(text.startsWith('This game records how each match plays') && href === '/privacy.html', `/ shows the data notice with its Privacy link to ${href ?? 'nowhere'}`);
  if (href === null) return;
  await link.click();
  await page.waitForURL('**/privacy.html', { timeout: TIMEOUT_MS }).catch(() => undefined);
  const heading = page.getByRole('heading', { level: 1, name: 'Privacy' });
  check(await heading.isVisible(), `the notice's Privacy link opens ${new URL(page.url()).pathname}${await heading.isVisible() ? ' and its Privacy heading' : ', which has no Privacy heading'}`);
}

async function get(url: string): Promise<{ status: number; body: string; why: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    return { status: response.status, body: await response.text(), why: `HTTP ${response.status}` };
  } catch (error) {
    return { status: 0, body: '', why: `no answer: ${firstLine(error)}` };
  }
}

const firstLine = (error: unknown) => (error instanceof Error ? String((error.cause as { code?: string } | undefined)?.code ?? error.message) : String(error)).split('\n')[0];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = process.argv[2];
  if (!site || !/^https?:\/\//.test(site)) {
    console.error('Usage: pnpm smoke:site <url>, such as pnpm smoke:site https://brick-arena.onrender.com');
    process.exit(2);
  }
  process.exitCode = await smokeSite(site) ? 0 : 1;
}
