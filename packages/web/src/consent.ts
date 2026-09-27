// Whether this browser lets the page record anything (docs/specs/data-collection.md,
// "Privacy"). The title screen's opt-out is remembered in localStorage under
// OPT_OUT_KEY; Do Not Track has the same effect and the page can't undo it.
// Both the PostHog events (analytics.ts) and the match lines (match-log.ts)
// ask `recording` before each send. Play never changes.
export const OPT_OUT_KEY = 'brick-arena:opt-out';

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type Choice = 'recording' | 'opted-out' | 'dnt';

export class Consent {
  private optedOut: boolean;
  private readonly listeners = new Set<(recording: boolean) => void>();

  constructor(private readonly store: Store | null, readonly dnt: boolean) {
    this.optedOut = attempt(() => store?.getItem(OPT_OUT_KEY) === '1', false);
  }

  get choice(): Choice {
    return this.dnt ? 'dnt' : this.optedOut ? 'opted-out' : 'recording';
  }

  get recording(): boolean {
    return this.choice === 'recording';
  }

  // Kept for this page even when the browser refuses to store it.
  optOut() { this.set(true); }
  optIn() { this.set(false); }

  onChange(listener: (recording: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private set(optedOut: boolean) {
    if (this.optedOut === optedOut) return;
    this.optedOut = optedOut;
    attempt(() => optedOut ? this.store?.setItem(OPT_OUT_KEY, '1') : this.store?.removeItem(OPT_OUT_KEY), undefined);
    for (const listener of this.listeners) listener(this.recording);
  }
}

// A private window or blocked site data can make storage throw.
function attempt<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

export function doNotTrack(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const flags = [navigator.doNotTrack, (window as { doNotTrack?: string }).doNotTrack, (navigator as { msDoNotTrack?: string }).msDoNotTrack];
  return flags.some(flag => flag === '1' || flag === 'yes');
}

export function browserStore(): Storage | null {
  return attempt(() => typeof window === 'undefined' ? null : window.localStorage, null);
}

// The page's one Consent, shared by its events and its match lines.
export const pageConsent = new Consent(browserStore(), doNotTrack());
