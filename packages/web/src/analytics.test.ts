import type { PostHog } from 'posthog-js';
import { describe, expect, it, vi } from 'vitest';
import { clientFor, MemoryClient, pageTracker, POSTHOG_SETTINGS, posthogClient, Tracker, type Client } from './analytics';
import { Consent } from './consent';

const ID = '20260927-010000-abcdef';

// A short live match, as main.tsx reports one.
function playMatch(tracker: Tracker, opponent: 'live' | 'stand-in' = 'live') {
  tracker.track('session_started', { viewport: '1280x800', pointer: 'fine', tuning: 'standard' });
  tracker.track('title_shown', { jev_online: true, probe_ms: 640 });
  tracker.startMatch(ID, opponent, { seed: 20260919, tuning: 'standard' });
  tracker.track('level_started', { level: 0, name: 'opening' });
  for (const [choice, outcome] of [['aim', 'answered'], ['landing', 'answered'], ['aim', 'answered'], ['aim', 'stale']] as const) {
    tracker.track('jev_decision', { level: 0, question: 'target', choice, outcome, answer_ms: 700, lead_ticks: 42 });
  }
  tracker.track('jev_decision', { level: 0, question: 'chase', choice: 'none', outcome: 'answered', answer_ms: 650, lead_ticks: 39 });
  tracker.track('jev_decision', { level: 0, question: 'target', choice: null, outcome: 'timeout', answer_ms: 2000, lead_ticks: 42 });
  tracker.track('ball_lost', { level: 0, side: 'human', x: 312, seconds_in: 14.5, life_lost: true });
  tracker.track('paused', { level: 0, seconds_in: 20 });
  tracker.track('resumed', { level: 0, seconds_in: 20 });
  tracker.track('level_ended', { level: 0, winner: 'jev', you_percent: 41, jev_percent: 100 });
  tracker.track('match_ended', { reason: 'left', you: 4100, jev: 12000, levels_won: 0 });
}

describe('the tracker', () => {
  it('sends the spec\'s events, each with app, build, schema and the match id in play', () => {
    const client = new MemoryClient();
    playMatch(new Tracker(client, 'abc123'));
    expect(client.sent.map(sent => sent.event)).toEqual([
      'session_started', 'title_shown', 'match_started', 'level_started',
      'jev_decision', 'jev_decision', 'jev_decision', 'jev_decision', 'jev_decision', 'jev_decision',
      'ball_lost', 'paused', 'resumed', 'level_ended', 'match_ended',
    ]);
    for (const { properties } of client.sent) expect(properties).toMatchObject({ app: 'brick-arena', build: 'abc123', schema: 1 });
    const matchIds = client.sent.map(sent => sent.properties.match_id);
    expect(matchIds.slice(0, 2)).toEqual([undefined, undefined]);
    expect(matchIds.slice(2).every(id => id === ID)).toBe(true);
  });

  it('names jev_decision\'s properties as the spec does', () => {
    const client = new MemoryClient();
    playMatch(new Tracker(client, null));
    const decision = client.sent.find(sent => sent.event === 'jev_decision')!.properties;
    expect(decision).toMatchObject({ level: 0, question: 'target', choice: 'aim', outcome: 'answered', answer_ms: 700, lead_ticks: 42 });
  });

  it('gives each level the share of answered target questions Jev aimed', () => {
    const client = new MemoryClient();
    playMatch(new Tracker(client, null));
    // Three answered target questions, two of them `aim`; the stale one, the
    // chase and the timeout do not count.
    expect(client.sent.find(sent => sent.event === 'level_ended')!.properties).toMatchObject({ level: 0, winner: 'jev', you_percent: 41, jev_percent: 100, jev_aim_share: 0.67 });
  });

  it('gives a level with no answered target question no aim share', () => {
    const client = new MemoryClient();
    const tracker = new Tracker(client, null);
    tracker.startMatch(ID, 'live', { seed: 20260919, tuning: 'standard' });
    tracker.track('level_ended', { level: 0, winner: 'tie', you_percent: 0, jev_percent: 0 });
    expect(client.sent.at(-1)!.properties.jev_aim_share).toBeNull();
  });

  it('drops the match id once the match ends', () => {
    const client = new MemoryClient();
    const tracker = new Tracker(client, null);
    playMatch(tracker);
    tracker.track('title_shown', { jev_online: true, probe_ms: 600 });
    expect(client.sent.at(-1)!.properties.match_id).toBeUndefined();
  });

  it('sends nothing for a match the stand-in plays', () => {
    const client = new MemoryClient();
    const tracker = new Tracker(client, null);
    tracker.startMatch(ID, 'stand-in', { seed: 20260919, tuning: 'standard' });
    tracker.track('level_started', { level: 0, name: 'opening' });
    tracker.track('match_ended', { reason: 'final', you: 1, jev: 2, levels_won: 0 });
    expect(client.sent).toEqual([]);
  });
});

describe('who hears the events', () => {
  const link = { key: 'phc_test_not_real', host: 'https://posthog.invalid' };

  it('is nobody in debug play, even with a PostHog project named', () => {
    const load = vi.fn();
    expect(clientFor({ debug: true, dnt: false, link, load })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('hears nothing of a whole debug match on the page', () => {
    const fetch = vi.fn(), sendBeacon = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('navigator', { sendBeacon });
    try {
      const tracker = pageTracker(true);
      expect(tracker.client).toBeNull();
      playMatch(tracker, 'stand-in');
      playMatch(tracker, 'live');
      expect(fetch).not.toHaveBeenCalled();
      expect(sendBeacon).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    // Out of debug, the same page keeps them in memory.
    expect(pageTracker(false).client).toBeInstanceOf(MemoryClient);
  });

  it('is nobody under Do Not Track', () => {
    const load = vi.fn();
    expect(clientFor({ debug: false, dnt: true, link, load })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('is the in-memory stand-in while the build names no PostHog project', () => {
    expect(clientFor({ debug: false, dnt: false, link: null })).toBeInstanceOf(MemoryClient);
  });

  it('keeps only the latest events in memory', () => {
    const client = new MemoryClient(2);
    for (const event of ['a', 'b', 'c']) client.capture(event, {});
    expect(client.sent.map(sent => sent.event)).toEqual(['b', 'c']);
  });
});

describe('the PostHog client', () => {
  const link = { key: 'phc_test_not_real', host: 'https://posthog.invalid' };
  const fakePostHog = (optedOut = false) => ({ init: vi.fn(), capture: vi.fn(), reset: vi.fn(), opt_out_capturing: vi.fn(), opt_in_capturing: vi.fn(), has_opted_out_capturing: vi.fn(() => optedOut) });

  it('starts PostHog with the spec\'s privacy settings', async () => {
    const posthog = fakePostHog();
    posthogClient(link, async () => ({ default: posthog as unknown as PostHog })).capture('session_started', {});
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
    expect(posthog.init).toHaveBeenCalledWith(link.key, expect.objectContaining({ api_host: link.host }));
    const settings = posthog.init.mock.calls[0][1];
    expect(settings).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      person_profiles: 'never',
      persistence: 'localStorage',
      respect_dnt: true,
      disable_session_recording: true,
    });
    expect(settings).toMatchObject(POSTHOG_SETTINGS);
  });

  it('sends the events captured while it loaded, in order', async () => {
    const posthog = fakePostHog();
    const client = posthogClient(link, async () => ({ default: posthog as unknown as PostHog }));
    client.capture('session_started', { n: 1 });
    client.capture('title_shown', { n: 2 });
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(2));
    client.capture('match_started', { n: 3 });
    expect(posthog.capture.mock.calls.map(([event]) => event)).toEqual(['session_started', 'title_shown', 'match_started']);
  });

  it('drops events when PostHog fails to load', async () => {
    let fail!: (error: Error) => void;
    const client = posthogClient(link, () => new Promise((_, reject) => { fail = reject; }));
    client.capture('session_started', {});
    fail(new Error('blocked'));
    await Promise.resolve();
    expect(() => client.capture('title_shown', {})).not.toThrow();
  });
});

describe('opting out', () => {
  const link = { key: 'phc_test_not_real', host: 'https://posthog.invalid' };
  const fakePostHog = (optedOut = false) => ({ init: vi.fn(), capture: vi.fn(), reset: vi.fn(), opt_out_capturing: vi.fn(), opt_in_capturing: vi.fn(), has_opted_out_capturing: vi.fn(() => optedOut) });
  const loader = (posthog: ReturnType<typeof fakePostHog>) => vi.fn(async () => ({ default: posthog as unknown as PostHog }));
  // localStorage as PostHog leaves it: its id under ph_<key>_…, and a key of the page's own.
  const storage = () => {
    const items = new Map([[`ph_${link.key}_posthog`, '{"distinct_id":"0199-anon"}'], ['brick-arena:opt-out', '1']]);
    return { items, get length() { return items.size; }, key: (i: number) => [...items.keys()][i] ?? null, removeItem: (key: string) => { items.delete(key); } };
  };

  it('stops the tracker\'s events, and opting back in starts them again', () => {
    const client = new MemoryClient();
    const consent = new Consent(null, false);
    const tracker = new Tracker(client, null, consent);
    tracker.track('title_shown', { jev_online: true, probe_ms: 600 });
    consent.optOut();
    playMatch(tracker);
    expect(client.sent.map(sent => sent.event)).toEqual(['title_shown']);
    consent.optIn();
    tracker.track('rules_opened', {});
    expect(client.sent.map(sent => sent.event)).toEqual(['title_shown', 'rules_opened']);
  });

  it('keeps counting a match it does not send, so a level after opting back in has its aim share', () => {
    const client = new MemoryClient();
    const consent = new Consent(null, false);
    const tracker = new Tracker(client, null, consent);
    consent.optOut();
    tracker.startMatch(ID, 'live', { seed: 20260919, tuning: 'standard' });
    tracker.track('jev_decision', { level: 0, question: 'target', choice: 'aim', outcome: 'answered', answer_ms: 700, lead_ticks: 42 });
    consent.optIn();
    tracker.track('level_ended', { level: 0, winner: 'jev', you_percent: 1, jev_percent: 2 });
    expect(client.sent.map(sent => [sent.event, sent.properties.jev_aim_share])).toEqual([['level_ended', 1]]);
  });

  it('tells the client each time the player opts out or back in', () => {
    const client: Client = { capture: vi.fn(), optOut: vi.fn(), optIn: vi.fn() };
    const consent = new Consent(null, false);
    new Tracker(client, null, consent);
    consent.optOut();
    consent.optIn();
    expect(client.optOut).toHaveBeenCalledTimes(1);
    expect(client.optIn).toHaveBeenCalledTimes(1);
  });

  it('never loads PostHog for a page that has opted out', async () => {
    const posthog = fakePostHog(), load = loader(posthog);
    const consent = new Consent(null, false);
    consent.optOut();
    const tracker = new Tracker(posthogClient(link, load, null), null, consent);
    playMatch(tracker);
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads PostHog only on the first event', async () => {
    const posthog = fakePostHog(), load = loader(posthog);
    const client = posthogClient(link, load, null);
    expect(load).not.toHaveBeenCalled();
    client.capture('session_started', {});
    client.capture('title_shown', {});
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('opts PostHog out and ends its anonymous id once it is loaded', async () => {
    const posthog = fakePostHog(), store = storage();
    const client = posthogClient(link, loader(posthog), store);
    client.capture('session_started', {});
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
    client.optOut!();
    expect(posthog.reset).toHaveBeenCalledWith(true);
    expect(posthog.opt_out_capturing).toHaveBeenCalled();
    client.capture('title_shown', {});
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    client.optIn!();
    expect(posthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
  });

  it('removes the stored anonymous id when PostHog never loaded, and nothing of the page\'s own', () => {
    const store = storage();
    posthogClient(link, loader(fakePostHog()), store).optOut!();
    expect([...store.items.keys()]).toEqual(['brick-arena:opt-out']);
  });

  it('opts PostHog out when the player opts out while it loads', async () => {
    const posthog = fakePostHog();
    const client = posthogClient(link, loader(posthog), null);
    client.capture('session_started', {});
    client.optOut!();
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
    expect(posthog.opt_out_capturing).toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('opts PostHog back in when an earlier visit opted it out and the player has since opted in', async () => {
    const posthog = fakePostHog(true);
    posthogClient(link, loader(posthog), null).capture('session_started', {});
    await vi.waitFor(() => expect(posthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false }));
    expect(posthog.opt_in_capturing.mock.invocationCallOrder[0]).toBeLessThan(posthog.capture.mock.invocationCallOrder[0]);
  });
});
