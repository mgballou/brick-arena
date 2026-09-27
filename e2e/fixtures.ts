import { test as base, expect, type Page } from '@playwright/test';
import { startStandIn } from '../packages/jev/src/stand-in-server.ts';
import { STAND_IN_PORT } from './servers.ts';

// The stand-in the dev server forwards to, one per worker, which a spec may
// stop and start again.
export type StandIn = { stop(): Promise<void>; start(): Promise<void> };

export const test = base.extend<{ shot: (name: string) => Promise<void> }, { standIn: StandIn }>({
  standIn: [async ({}, use) => {
    let close: (() => Promise<void>) | null = null;
    const standIn: StandIn = {
      async start() { if (!close) close = (await startStandIn({ port: STAND_IN_PORT })).close; },
      async stop() { await close?.(); close = null; },
    };
    await standIn.start();
    await use(standIn);
    await standIn.stop();
  }, { scope: 'worker', auto: true }],

  // The one screenshot each spec takes at its end, kept with its results.
  shot: async ({ page }, use, testInfo) => {
    await use(async name => {
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    });
  },
});

export { expect };

// What `window.__arena.read()` returns (main.tsx), as far as the specs read it.
type Ball = { x: number; y: number; vx: number; vy: number };
export type Read = {
  phase: string;
  matchId: string | null;
  debug: boolean;
  opponent: string;
  level: number;
  seconds: number;
  human: { paddle: number; serving: boolean; balls: Ball[]; lives: number };
  results: { level: number; winner: string; human: number; jev: number }[];
};

export const read = (page: Page) => page.evaluate(() => (window as unknown as { __arena: { read(): Read } }).__arena.read());

// The title screen, once the stand-in has answered its check.
export async function openTitle(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Debug: the stand-in answered, not Jev')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
}

// Plays the human board on the keys until the level ends: launch when
// serving, and hold the arrow toward the lowest falling ball.
export async function playLevel(page: Page, limitMs: number): Promise<Read> {
  const deadline = Date.now() + limitMs;
  let held: 'ArrowLeft' | 'ArrowRight' | null = null;
  const hold = async (key: typeof held) => {
    if (held === key) return;
    if (held) await page.keyboard.up(held);
    if (key) await page.keyboard.down(key);
    held = key;
  };
  while (Date.now() < deadline) {
    const now = await read(page);
    if (now.phase === 'levelEnd') { await hold(null); return now; }
    if (now.phase === 'banner') await page.keyboard.press('Space');
    if (now.phase === 'playing') {
      const me = now.human;
      if (me.serving) await page.keyboard.press('Space');
      const ball = [...me.balls].filter(b => b.vy > 0).sort((a, b) => b.y - a.y)[0] ?? me.balls[0];
      const gap = ball ? ball.x - me.paddle : 0;
      await hold(Math.abs(gap) < 12 ? null : gap > 0 ? 'ArrowRight' : 'ArrowLeft');
    }
    await page.waitForTimeout(30);
  }
  await hold(null);
  throw new Error(`level ${(await read(page)).level + 1} did not end in ${limitMs} ms`);
}
