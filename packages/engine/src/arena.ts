import { createBoard, PADDLE_Y, step, type BoardState, type PowerUpKind } from './index.ts';

// The arcade rules the web game plays by, layered over the pure board. Nothing
// here changes `step`, so recorded sessions still replay against the engine as
// it was recorded. Every function is pure: same input, same output.
export const ARENA = {
  levels: 5,
  lives: 3,
  askEvery: 30,
  levelSeconds: 90,
  ticksPerSecond: 60,
  // After a lost ball, Jev serves this many ticks later; you serve on Space.
  serveTicks: 45,
  paddleWidth: 120,
  paddleSpeed: 7,
  // A return never goes steeper than this: a dead-center catch would
  // otherwise send the ball straight up and down the same column forever.
  minReturnVx: 1.1,
} as const;

// A tuning changes how fast a level can be cleared without touching `step`, so
// recorded sessions still replay. The web game picks one with `?tuning=`, and
// `pnpm tunings` measures each (docs/tunings.md). `standard` is the game as it
// was before tunings existed, and stays the default.
export type Tuning = {
  paddleWidth: number;
  // The paddle never drops below this speed; the long paddle power-up sets 3.
  minPaddleSpeed: number;
  // A return from the paddle never goes steeper than this sideways speed.
  minReturnVx: number;
  // No breakable brick starts with more hit points than this.
  maxHitPoints: number;
};

export const TUNINGS = {
  standard: { paddleWidth: ARENA.paddleWidth, minPaddleSpeed: 0, minReturnVx: ARENA.minReturnVx, maxHitPoints: Infinity },
  // Every catch leaves at an angle, so the ball stops looping up one column.
  angled: { paddleWidth: 130, minPaddleSpeed: ARENA.paddleSpeed, minReturnVx: 1.6, maxHitPoints: Infinity },
  // Every breakable brick breaks on its first hit, and so none regenerates.
  'one-hit': { paddleWidth: ARENA.paddleWidth, minPaddleSpeed: ARENA.paddleSpeed, minReturnVx: ARENA.minReturnVx, maxHitPoints: 1 },
} as const satisfies Record<string, Tuning>;
export type TuningName = keyof typeof TUNINGS;
export const isTuningName = (name: string | null | undefined): name is TuningName => !!name && Object.hasOwn(TUNINGS, name);

// Performance is clearing fast (docs/scoring.md). A level scores the share of
// its brick hit points broken, plus the seconds left when it is cleared. Only a
// clear reaches 100 percent, so whoever clears first always leads; a lost ball
// and a caught power-up score nothing in themselves.
export const POINTS = { percentCleared: 10, secondLeft: 10 } as const;

export type ArenaEvents = {
  hits: Array<{ x: number; y: number; broke: boolean; maxDurability: number }>;
  paddleBounces: number[];
  caught: PowerUpKind[];
  lifeLost: boolean;
};

// createBoard's 180-wide paddle covers most of a 480 board and never misses;
// the arena narrows it and speeds it up to suit held arrow keys.
export function arenaBoard(seed: number, level: number, tuning: Tuning = TUNINGS.standard): BoardState {
  const board = createBoard(seed, level);
  for (const brick of board.bricks) {
    if (brick.unbreakable) continue;
    brick.durability = brick.maxDurability = Math.min(brick.maxDurability, tuning.maxHitPoints);
  }
  board.paddleWidth = tuning.paddleWidth;
  board.paddleSpeed = ARENA.paddleSpeed;
  board.paddleX = board.width / 2 - board.paddleWidth / 2;
  board.paddleTargetX = board.width / 2;
  board.minReturnVx = tuning.minReturnVx;
  return board;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Before a serve the clock stands still: the paddle moves as `step` would move
// it, and the one ball rides on top of it.
export function holdServe(state: BoardState): BoardState {
  const next = structuredClone(state);
  const center = next.paddleX + next.paddleWidth / 2;
  next.paddleX += clamp(next.paddleTargetX - center, -next.paddleSpeed, next.paddleSpeed);
  next.paddleX = clamp(next.paddleX, 0, next.width - next.paddleWidth);
  const ball = next.balls[0];
  ball.x = next.paddleX + next.paddleWidth / 2;
  ball.y = PADDLE_Y - ball.radius - 1;
  return next;
}

// Launches toward the middle of the board, so a serve from either wall stays in play.
export function launch(state: BoardState): BoardState {
  const next = structuredClone(state);
  const ball = next.balls[0];
  ball.vx = ball.x < next.width / 2 ? 2.2 : -2.2;
  ball.vy = -2.6;
  return next;
}

export function livesLeft(state: BoardState) {
  return Math.max(0, ARENA.lives - state.livesLost);
}

export type SideStatus = 'playing' | 'cleared' | 'out';
export function sideStatus(state: BoardState): SideStatus {
  if (state.completed) return 'cleared';
  return livesLeft(state) === 0 ? 'out' : 'playing';
}

// One step of `step`, read back as the events a game scores and shows. A ball
// that falls while another is in play is just gone; only the last ball costs
// a life, and `lifeLost` tells the caller to hold for a serve.
export function arenaStep(state: BoardState, tuning: Tuning = TUNINGS.standard): { state: BoardState; events: ArenaEvents } {
  const next = step(state);
  next.paddleSpeed = Math.max(next.paddleSpeed, tuning.minPaddleSpeed);
  const events: ArenaEvents = { hits: [], paddleBounces: [], caught: [], lifeLost: false };

  next.bricks.forEach((brick, index) => {
    const before = state.bricks[index];
    if (!before || brick.durability >= before.durability) return;
    const broke = brick.durability === 0;
    events.hits.push({ x: brick.x + brick.width / 2, y: brick.y + brick.height / 2, broke, maxDurability: brick.maxDurability });
  });

  for (const power of state.powerUps) {
    if (power.y < state.height && !next.powerUps.some(item => item.id === power.id)) events.caught.push(power.kind);
  }

  const lost = state.balls.filter(ball => ball.y + ball.vy > state.height + 20).map(ball => ball.id);
  if (lost.length) {
    const kept = next.balls.filter(ball => !lost.includes(ball.id));
    if (kept.length) {
      next.balls = kept;
    } else {
      next.balls = [next.balls.find(ball => ball.id === lost[0])!];
      events.lifeLost = true;
    }
    next.livesLost = state.livesLost + (events.lifeLost ? 1 : 0);
    if (!next.balls.some(ball => ball.tracked)) next.balls[0].tracked = true;
  }

  // step names a new ball by the count of balls, which can repeat an id once
  // one has been dropped above; give the newcomer the tick instead.
  const seen = new Set<string>();
  for (const ball of next.balls) {
    if (seen.has(ball.id)) ball.id = `ball-t${next.tick}`;
    seen.add(ball.id);
  }

  for (const ball of next.balls) {
    const before = state.balls.find(item => item.id === ball.id);
    if (!before || before.vy <= 0 || ball.vy >= 0 || ball.y < PADDLE_Y - ball.radius - 0.001) continue;
    events.paddleBounces.push(ball.x);
    if (Math.abs(ball.vx) < tuning.minReturnVx) ball.vx = (ball.vx === 0 ? (before.vx >= 0 ? 1 : -1) : Math.sign(ball.vx)) * tuning.minReturnVx;
  }

  return { state: next, events };
}

// A ball that turned between two boards: the landing point last chosen for it
// has just moved, so a seated player is asked again.
export function bounced(before: BoardState, after: BoardState): boolean {
  return after.balls.some(ball => {
    const was = before.balls.find(item => item.id === ball.id);
    return was !== undefined && Math.sign(was.vy) !== Math.sign(ball.vy);
  });
}

// The board as it will stand `leadTicks` from now if nobody moves the paddle.
// Asking about it rather than the board on screen means an answer that takes
// that long lands on the moment it was chosen for. It stops short of a lost
// life, a clear or a lost level, since past those there is nothing to answer.
export function boardAhead(state: BoardState, leadTicks: number, tuning: Tuning = TUNINGS.standard): BoardState {
  let ahead = state;
  for (let i = 0; i < leadTicks; i++) {
    const { state: next, events } = arenaStep(ahead, tuning);
    if (events.lifeLost || sideStatus(next) !== 'playing') break;
    ahead = next;
  }
  return ahead;
}

// The share of the level's breakable hit points broken, 0 to 100, rounded
// down so that only a clear reads 100. A hit point that regenerates counts as
// unbroken again.
export function percentCleared(state: BoardState): number {
  let total = 0, left = 0;
  for (const brick of state.bricks) if (!brick.unbreakable) { total += brick.maxDurability; left += brick.durability; }
  return total ? Math.floor((100 * (total - left)) / total) : 100;
}

export function clearBonus(secondsLeft: number) {
  return Math.max(0, Math.floor(secondsLeft)) * POINTS.secondLeft;
}

// A side's score on a level: what it has cleared, plus the clock it left if it
// cleared. `clearedAt` is the frame of the clear, counted from the level's start.
export function levelScore(state: BoardState, clearedAt: number | null): number {
  const bonus = clearedAt === null ? 0 : clearBonus(ARENA.levelSeconds - clearedAt / ARENA.ticksPerSecond);
  return POINTS.percentCleared * percentCleared(state) + bonus;
}

export type LevelSide = { status: SideStatus; clearedAt: number | null; levelScore: number };

// A level ends when either side clears it, when neither side can play on, or
// when the clock runs out.
export function levelOver(human: LevelSide, jev: LevelSide, secondsLeft: number): boolean {
  if (human.status === 'cleared' || jev.status === 'cleared') return true;
  if (human.status !== 'playing' && jev.status !== 'playing') return true;
  return secondsLeft <= 0;
}

// The higher level score takes the level. A clear ends the level and only a
// clear reaches 100 percent, so this is the first to clear, or else the larger
// share cleared; the same share, or a clear on the same frame, is a tie.
export function levelWinner(human: LevelSide, jev: LevelSide): 'human' | 'jev' | 'tie' {
  if (human.levelScore !== jev.levelScore) return human.levelScore > jev.levelScore ? 'human' : 'jev';
  return 'tie';
}
