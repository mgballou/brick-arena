import { parseArgs } from 'node:util';
import { applyDecision, askForDecision, predictPaddleX, type BoardState, type Decision } from '../../engine/src/index.ts';
import { ARENA, arenaBoard, arenaStep, boardAhead, bounced, holdServe, launch, sideStatus } from '../../engine/src/arena.ts';
import { standInChoice } from '../../jev/src/stand-in.ts';
import { fromResponse, toRequest } from '../../jev/src/wire.ts';

// Is the match fair? Plays both boards of the web game headless, on one seed,
// in game time, and counts the balls each side loses. The Jev side is the
// stand-in's rule answering after a fixed --ms; the other side is a player on
// the arrow keys who sees the board --react ms late. Each board plays every
// level for the full clock, or until it clears or runs out of balls.
//
//   pnpm fair                   (728 ms: the one live Jev call, 22 September)
//   pnpm fair --ms 421 --react 250
//
// Modes for the Jev board:
//   late   asks about the board on screen; the answer lands --ms later (the game before this fix)
//   ahead  asks about the board as it will stand when the answer lands (the game now)
//   hold   asks about the board on screen and holds that board until the answer lands
const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '20260919' },
    ms: { type: 'string', default: '728' },
    react: { type: 'string', default: '200' },
  },
});

const SEED = Number(values.seed);
const TICK_MS = 1000 / ARENA.ticksPerSecond;
const LATE_TICKS = Math.ceil(Number(values.ms) / TICK_MS);
const REACT_TICKS = Math.round(Number(values.react) / TICK_MS);
const LEVEL_FRAMES = ARENA.levelSeconds * ARENA.ticksPerSecond;
// The web game's Jev waits this long before it serves; the keys player matches it.
const SERVE_TICKS = 45;

type Mode = 'late' | 'ahead' | 'hold';
type Result = { livesLost: number; bricks: number; cleared: boolean; framesPlayed: number; framesHeld: number; calls: number };

function standIn(state: BoardState, ahead: number): Decision {
  const ask = askForDecision(ahead ? boardAhead(state, ahead) : state);
  const request = toRequest(ask, 'stand-in');
  const choice = standInChoice(request);
  return fromResponse(ask, { answers: { decision: { type: 'choice', choice } } });
}

// Arrow keys toward where the lowest falling ball will land, as seen `REACT_TICKS` ago.
function keysTarget(seen: BoardState, now: BoardState): Decision {
  const center = now.paddleX + now.paddleWidth / 2;
  const falling = seen.balls.filter(ball => ball.vy > 0).sort((a, b) => b.y - a.y)[0];
  const goal = falling ? predictPaddleX(falling) : seen.balls[0].x;
  const gap = goal - center;
  return { kind: 'target', x: Math.abs(gap) < 6 ? center : center + Math.sign(gap) * 80 };
}

function play(level: number, side: 'keys' | Mode): Result {
  let state = arenaBoard(SEED, level);
  let serving = true, serveWait = 0, framesHeld = 0, calls = 0, frame = 0;
  let pending: { decision: Decision; landsAt: number } | null = null;
  const seen: BoardState[] = [];

  for (; frame < LEVEL_FRAMES && sideStatus(state) === 'playing'; frame++) {
    if (pending && frame >= pending.landsAt) {
      state = applyDecision(state, pending.decision);
      pending = null;
    }
    if (side === 'keys') {
      seen.push(state);
      if (seen.length > REACT_TICKS + 1) seen.shift();
      state = applyDecision(state, keysTarget(seen[0], state));
    }
    if (serving) {
      state = holdServe(state);
      if (++serveWait >= SERVE_TICKS) { state = launch(state); serving = false; serveWait = 0; }
      continue;
    }
    if (side === 'hold' && pending) { framesHeld++; continue; }
    const before = state;
    const { state: next, events } = arenaStep(before);
    state = next;
    if (events.lifeLost) serving = true;
    const due = !serving && !state.completed && (bounced(before, state) || state.tick % ARENA.askEvery === 0);
    if (side !== 'keys' && due && !pending) {
      calls++;
      pending = { decision: standIn(state, side === 'ahead' ? LATE_TICKS : 0), landsAt: frame + LATE_TICKS };
    }
  }
  return { livesLost: state.livesLost, bricks: state.bricksCleared, cleared: state.completed, framesPlayed: frame, framesHeld, calls };
}

console.log(`seed ${SEED}; Jev answers in ${values.ms} ms (${LATE_TICKS} ticks); keys react in ${values.react} ms (${REACT_TICKS} ticks); ${ARENA.levels} levels of ${ARENA.levelSeconds} s`);
const sides = ['keys', 'late', 'ahead', 'hold'] as const;
const totals = Object.fromEntries(sides.map(side => [side, { livesLost: 0, bricks: 0, cleared: 0, held: 0 }]));
for (let level = 0; level < ARENA.levels; level++) {
  const row = sides.map(side => {
    const r = play(level, side);
    const t = totals[side];
    t.livesLost += r.livesLost; t.bricks += r.bricks; t.cleared += r.cleared ? 1 : 0; t.held += r.framesHeld;
    return `${side} ${r.livesLost} lost, ${r.bricks} bricks${r.cleared ? ', cleared' : ''}${r.framesHeld ? `, ${(r.framesHeld / ARENA.ticksPerSecond).toFixed(1)} s held` : ''} (${(r.framesPlayed / ARENA.ticksPerSecond).toFixed(1)} s)`;
  });
  console.log(`level ${level + 1}: ${row.join(' | ')}`);
}
for (const side of sides) {
  const t = totals[side];
  const gap = side === 'keys' ? '' : `; gap to keys ${Math.abs(t.livesLost - totals.keys.livesLost)}`;
  console.log(`${side.padEnd(5)} balls lost ${t.livesLost}, bricks ${t.bricks}, levels cleared ${t.cleared}${t.held ? `, ${(t.held / ARENA.ticksPerSecond).toFixed(1)} s held` : ''}${gap}`);
}
