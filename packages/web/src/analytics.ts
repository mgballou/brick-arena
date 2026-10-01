import type { PostHog, PostHogConfig } from 'posthog-js';
import type { AnsweredBy } from '../../jev/src/wire';
import type { JevOutcome } from '../../server/src/record';
import { browserStore, pageConsent, type Consent } from './consent';

// What players do, and each Jev choice in brief, as PostHog events
// (docs/specs/data-collection.md). The page talks to a Client; posthog-js is
// one only when the build sets VITE_POSTHOG=1, VITE_POSTHOG_KEY and
// VITE_POSTHOG_HOST. Otherwise the page keeps its events in memory and sends
// nothing. Debug play, stand-in matches, Do Not Track and the title screen's
// opt-out (consent.ts) send nothing at all.
// Analytics never touches play: a client that fails is dropped.
const SCHEMA = 1;

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

// The seam over PostHog: the page and the tests hold one of these. The
// tracker tells it when the player opts out or back in.
export type Client = { capture(event: string, properties: Record<string, unknown>): void; optOut?(): void; optIn?(): void };

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

// With `persistence: 'localStorage'`, posthog-js keeps the anonymous id under
// `ph_<project key>_…`. Removing those keys ends the id.
export type IdStore = Pick<Storage, 'length' | 'key' | 'removeItem'>;
function forgetId(link: PostHogLink, store: IdStore | null) {
  try {
    if (!store) return;
    const kept = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((key): key is string => !!key?.startsWith(`ph_${link.key}_`));
    for (const key of kept) store.removeItem(key);
  } catch { /* storage refused; nothing was kept */ }
}

// posthog-js, loaded on the first event, so a browser that has opted out
// never loads it. Events wait for it in order; if it fails to load, they are
// dropped from then on. Opting out ends the anonymous id: PostHog resets it
// and opts out if it is loaded, and otherwise its stored copy is removed.
export function posthogClient(link: PostHogLink, load: LoadPostHog, store: IdStore | null = browserStore()): Client {
  let posthog: PostHog | null = null;
  let loading = false;
  let failed = false;
  let on = true;
  const waiting: Sent[] = [];
  const stop = (loaded: PostHog) => { loaded.reset(true); loaded.opt_out_capturing(); };
  const start = () => {
    loading = true;
    void load().then(({ default: loaded }) => {
      loaded.init(link.key, { api_host: link.host, ...POSTHOG_SETTINGS });
      posthog = loaded;
      // An opt-out on an earlier visit stays in PostHog's own storage.
      if (!on) stop(loaded);
      else if (loaded.has_opted_out_capturing()) loaded.opt_in_capturing({ captureEventName: false });
      for (const { event, properties } of waiting.splice(0)) loaded.capture(event, properties);
    }, () => { failed = true; waiting.length = 0; });
  };
  return {
    capture(event, properties) {
      if (!on || failed) return;
      if (posthog) return posthog.capture(event, properties);
      waiting.push({ event, properties });
      if (!loading) start();
    },
    optOut() {
      on = false;
      waiting.length = 0;
      if (posthog) stop(posthog);
      else forgetId(link, store);
    },
    optIn() {
      on = true;
      posthog?.opt_in_capturing({ captureEventName: false });
    },
  };
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
// while a match plays), and sends nothing for a match the stand-in plays or
// while the player has opted out.
export class Tracker {
  private match: InMatch | null = null;

  constructor(readonly client: Client | null, private readonly build: string | null, private readonly consent: Pick<Consent, 'recording' | 'onChange'> | null = null) {
    consent?.onChange(recording => recording ? client?.optIn?.() : client?.optOut?.());
  }

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
    if (!this.client || (this.consent && !this.consent.recording) || (match && !match.live)) return;
    this.client.capture(event, { app: 'brick-arena', build: this.build, schema: SCHEMA, ...(match ? { match_id: match.id } : {}), ...properties });
  }
}

// The page's own tracker. The PostHog branch is decided when the page is
// built, so with the flag off the bundle holds no posthog-js at all
// (bundle.test.ts).
const LINK: PostHogLink | null = import.meta.env.VITE_POSTHOG === '1' && import.meta.env.VITE_POSTHOG_KEY && import.meta.env.VITE_POSTHOG_HOST
  ? { key: import.meta.env.VITE_POSTHOG_KEY, host: import.meta.env.VITE_POSTHOG_HOST }
  : null;

export function pageTracker(debug: boolean, consent: Consent = pageConsent): Tracker {
  const load: LoadPostHog | undefined = LINK ? () => import('posthog-js') : undefined;
  return new Tracker(clientFor({ debug, dnt: consent.dnt, link: LINK, load }), __BUILD__, consent);
}
