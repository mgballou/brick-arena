// A ceiling on Jev calls, so a bot can't spend the key's credits. It is not a
// paywall: the defaults cover a few colleagues playing all day. A full match is
// at most about 900 calls (five 90-second levels, one call in flight at a time),
// so a visitor gets five or so matches a day and everyone together about fifty.
// Counts live in memory and start again at midnight UTC or on a restart.
export const CAP_DEFAULTS = { perVisitor: 5000, total: 50000 } as const;

export type CapLimits = { perVisitor: number; total: number };
// `visitor` and `total` name the limit a refused call hit.
export type Take = 'ok' | 'visitor' | 'total';
export type Cap = { limits: CapLimits; take: (visitor: string) => Take };

const utcDay = () => new Date().toISOString().slice(0, 10);

export function createCap(limits: CapLimits, today: () => string = utcDay): Cap {
  let day = '';
  let total = 0;
  const visitors = new Map<string, number>();
  return {
    limits,
    take(visitor) {
      const now = today();
      if (now !== day) {
        day = now;
        total = 0;
        visitors.clear();
      }
      if (total >= limits.total) return 'total';
      const used = visitors.get(visitor) ?? 0;
      if (used >= limits.perVisitor) return 'visitor';
      visitors.set(visitor, used + 1);
      total++;
      return 'ok';
    },
  };
}

// JEV_CALLS_PER_VISITOR_PER_DAY and JEV_CALLS_PER_DAY, each a whole number.
// Unset or unreadable, a limit keeps its default.
export function capFromEnv(env: Record<string, string | undefined>, today?: () => string): Cap {
  const read = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return env[name]?.trim() && Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return createCap({ perVisitor: read('JEV_CALLS_PER_VISITOR_PER_DAY', CAP_DEFAULTS.perVisitor), total: read('JEV_CALLS_PER_DAY', CAP_DEFAULTS.total) }, today);
}
