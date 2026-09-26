import type { PowerUpKind } from '../../engine/src/index';

// What a stand-in reads of a request: the offered keys, and the board it was
// sent (wire.ts's boardForJev), which names each power-up's kind and whether
// going for it keeps the ball, and each ball's heading.
export type StandInRequest = { state?: unknown; questions?: { decision?: { criteria?: Record<string, unknown> } } };
type SentBoard = { powerUps?: Array<{ id: string; kind: PowerUpKind; keepsBall?: boolean }>; balls?: Array<{ id: string; y: number; vy: number }> } | undefined;
export type StandInPolicy = (request: StandInRequest) => string;

const keysOf = (request: StandInRequest) => Object.keys(request.questions?.decision?.criteria ?? {});

// The stand-in before docs/scoring.md: `landing` for a target ask, otherwise
// the first key offered. Kept to measure the new rule against.
export const alwaysLanding: StandInPolicy = request => {
  const keys = keysOf(request);
  return keys.includes('landing') ? 'landing' : keys[0] ?? 'ready';
};

const HELPS_CLEAR: PowerUpKind[] = ['extra-ball', 'piercing-ball'];

// The prompt's objective as a fixed rule: keep the ball first, then clear
// fast. Aim every catch at the densest open column, go for a power-up only when
// it breaks bricks faster and the paddle can still get back under the ball,
// and with several balls play the lowest one falling.
export const clearFast: StandInPolicy = request => {
  const keys = keysOf(request);
  const board = request.state as SentBoard;
  if (keys.includes('aim')) return 'aim';
  if (keys.includes('none')) {
    const helpful = board?.powerUps?.find(power => keys.includes(power.id) && HELPS_CLEAR.includes(power.kind) && power.keepsBall !== false);
    return helpful?.id ?? 'none';
  }
  const falling = board?.balls?.filter(ball => keys.includes(ball.id) && ball.vy > 0).sort((a, b) => b.y - a.y)[0];
  return falling?.id ?? keys[0] ?? 'ready';
};

// The stand-in's whole rule, shared by `pnpm jev:stub`, `pnpm fair` and
// `pnpm objective`, so the measured stand-in and the one you play against
// choose alike.
export const standInChoice = clearFast;
