/// <reference types="vite/client" />

interface ImportMetaEnv {
  // "1" lets the stand-in play in place of Jev, with a DEBUG banner on screen.
  readonly VITE_DEBUG?: string;
  // "1" sends the page's events to PostHog, with the project's key and host
  // (analytics.ts). All three are read when the page is built; unset, the
  // page keeps its events in memory and loads no PostHog.
  readonly VITE_POSTHOG?: string;
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
}

// The git commit the page was built from (vite.config.ts), or null.
declare const __BUILD__: string | null;
