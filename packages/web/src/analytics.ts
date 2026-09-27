import type { PostHog, PostHogConfig } from 'posthog-js';
import type { AnsweredBy } from '../../jev/src/wire';
import type { JevOutcome } from '../../server/src/record';

// What players do, and each Jev choice in brief, as PostHog events
// (docs/specs/data-collection.md). The page talks to a Client; posthog-js is
// one only when the build sets VITE_POSTHOG=1, VITE_POSTHOG_KEY and
// VITE_POSTHOG_HOST. Otherwise the page keeps its events in memory and sends
// nothing. Debug play, stand-in matches and Do Not Track send nothing at all.
// Analytics never touches play: a client that fails is dropped.
export const SCHEMA = 1;

// The events and their properties, as the spec lists them.
export type Events = {
  session_started: { viewport: string; pointer: 'fine' | 'coarse'; tuning: string };
  title_shown: { jev_online: boolean; probe_ms: number | null };
  rules_opened: Record<string, never>;
  match_started: { seed: number; tuning: string };
  level_started: { level: number; name: string };
  ball_lost: { level: number; side: 'human' | 'jev'; x: number; seconds_in: number; life_lost: boolean };
  paused: { level: number; seconds_in: number };
  resumed: { level: number; seconds_in: number };
  jev_decision: { level: number; question: string; choice: string | null; outcome: JevOutcome; answer_ms: number; lead_ticks: number };
  // `jev_aim_share` is the share of the level's answered `target` questions
  // where Jev chose `aim`; the tracker counts it from `jev_decision`.
  level_ended: { level: number; winner: 'human' | 'jev' | 'tie'; you_percent: number; jev_percent: number; jev_aim_share: number | null };
  // `levels_won` counts the player's.
  match_ended: { reason: 'final' | 'down' | 'left'; you: number; jev: number; levels_won: number };
};
type Given = { [E in keyof Events]: E extends 'level_ended' ? Omit<Events[E], 'jev_aim_share'> : Events[E] };

export type Sent = { event: string; properties: Record<string, unknown> };

// The seam over PostHog: the page and the tests hold one of these.
export type Client = { capture(event: string, properties: Record<string, unknown>): void };

// The stand-in for PostHog until its project exists: it keeps the latest
// events and sends none.
export class MemoryClient implements Client {
  readonly sent: Sent[] = [];
  constructor(private readonly keep = 1000) {}
  capture(event: string, properties: Record<string, unknown>) {
    this.sent.push({ event, properties });
    if (this.sent.length > this.keep) this.sent.shift();
  }
}

// The privacy settings the spec names. The anonymous id lives in
// localStorage, the page never calls `identify`, and PostHog keeps no person
// profiles. Only the events above count: no autocapture, no pageviews, no
// replay, no surveys, no flags, and no scripts fetched from PostHog later.
// IP capture is a project setting, off in PostHog's dashboard.
export const POSTHOG_SETTINGS = {
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  person_profiles: 'never',
  persistence: 'localStorage',
  respect_dnt: true,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
} satisfies Partial<PostHogConfig>;

export type PostHogLink = { key: string; host: string };
export type LoadPostHog = () => Promise<{ default: PostHog }>;

// posthog-js, loaded when first needed. Events wait for it in order; if it
// fails to load, they are dropped from then on.
export function posthogClient(link: PostHogLink, load: LoadPostHog): Client {
  let posthog: PostHog | null = null;
  let failed = false;
  const waiting: Sent[] = [];
  void load().then(({ default: loaded }) => {
    loaded.init(link.key, { api_host: link.host, ...POSTHOG_SETTINGS });
    posthog = loaded;
    for (const { event, properties } of waiting.splice(0)) loaded.capture(event, properties);
  }, () => { failed = true; waiting.length = 0; });
  return {
    capture(event, properties) {
      if (posthog) posthog.capture(event, properties);
      else if (!failed) waiting.push({ event, properties });
    },
  };
}

export function doNotTrack(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const flags = [navigator.doNotTrack, (window as { doNotTrack?: string }).doNotTrack, (navigator as { msDoNotTrack?: string }).msDoNotTrack];
  return flags.some(flag => flag === '1' || flag === 'yes');
}

// Who hears the page's events: nobody in debug or under Do Not Track, PostHog
// when the build names a project, else the in-memory stand-in.
export function clientFor({ debug, dnt, link, load }: { debug: boolean; dnt: boolean; link: PostHogLink | null; load?: LoadPostHog }): Client | null {
  if (debug || dnt) return null;
  if (link && load) return posthogClient(link, load);
  return new MemoryClient();
}

type InMatch = { id: string; live: boolean; targets: Map<number, { answered: number; aim: number }> };

// Adds what every event carries (`app`, `build`, `schema`, and `match_id`
// while a match plays), and sends nothing for a match the stand-in plays.
export class Tracker {
  private match: InMatch | null = null;

  constructor(readonly client: Client | null, private readonly build: string | null) {}

  startMatch(id: string, opponent: AnsweredBy, properties: Events['match_started']) {
    this.match = { id, live: opponent === 'live', targets: new Map() };
    this.track('match_started', properties);
  }

  track<E extends keyof Events>(event: E, given: Given[E]) {
    const match = this.match;
    if (match && event === 'jev_decision') {
      const { level, question, choice, outcome } = given as Events['jev_decision'];
      if (question === 'target' && outcome === 'answered') {
        const tally = match.targets.get(level) ?? { answered: 0, aim: 0 };
        tally.answered++;
        if (choice === 'aim') tally.aim++;
        match.targets.set(level, tally);
      }
    }
    let properties: Record<string, unknown> = given;
    if (event === 'level_ended') {
      const tally = match?.targets.get((given as Given['level_ended']).level);
      properties = { ...given, jev_aim_share: tally ? Math.round(tally.aim / tally.answered * 100) / 100 : null };
    }
    if (event === 'match_ended') this.match = null;
    if (!this.client || (match && !match.live)) return;
    this.client.capture(event, { app: 'brick-arena', build: this.build, schema: SCHEMA, ...(match ? { match_id: match.id } : {}), ...properties });
  }
}

// The page's own tracker. The PostHog branch is decided when the page is
// built, so with the flag off the bundle holds no posthog-js at all
// (bundle.test.ts).
const LINK: PostHogLink | null = import.meta.env.VITE_POSTHOG === '1' && import.meta.env.VITE_POSTHOG_KEY && import.meta.env.VITE_POSTHOG_HOST
  ? { key: import.meta.env.VITE_POSTHOG_KEY, host: import.meta.env.VITE_POSTHOG_HOST }
  : null;

export function pageTracker(debug: boolean): Tracker {
  const load: LoadPostHog | undefined = LINK ? () => import('posthog-js') : undefined;
  return new Tracker(clientFor({ debug, dnt: doNotTrack(), link: LINK, load }), __BUILD__);
}
