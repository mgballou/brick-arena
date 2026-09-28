import { defineConfig, devices } from '@playwright/test';
import { DEV_URL, dummyKeyFile, HOSTED_URL, OUT, POSTHOG_HOST, STAND_IN_PORT } from './e2e/servers.ts';

// The browser specs (e2e/*.e2e.ts), in Chromium: `pnpm e2e`. They play the real
// page against the stand-in, which e2e/fixtures.ts runs in the test process so
// a spec can stop it. Neither server can reach Jev (e2e/servers.ts), and
// neither reuses a server already running, which might hold the real key.
// Headed or not, the page is dark: it has no light theme.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  // One stand-in on one port, and the down spec stops it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: DEV_URL,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // Debug mode, the stand-in's address and a dummy key: the documented
      // way to play without Jev (README, "Debug mode, without Jev").
      command: `pnpm exec vite --host 127.0.0.1 --port ${new URL(DEV_URL).port} --strictPort`,
      url: `${DEV_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        VITE_DEBUG: '1',
        JEV_KEY_FILE: dummyKeyFile(),
        JEV_BASE_URL: `http://127.0.0.1:${STAND_IN_PORT}`,
        MATCHES_DIR: `${OUT}/dev-matches`,
      },
    },
    {
      // The page as Render builds it, with PostHog on and pointed at a host the
      // specs answer themselves, served by the hosted app with no key.
      command: `pnpm exec vite build --outDir ${OUT}/dist --emptyOutDir && node e2e/hosted.ts`,
      url: `${HOSTED_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        VITE_DEBUG: '',
        VITE_POSTHOG: '1',
        VITE_POSTHOG_KEY: 'phc_e2e',
        VITE_POSTHOG_HOST: POSTHOG_HOST,
      },
    },
  ],
});
