import { parseArgs } from 'node:util';
import { applyDecision, askForDecision, type BoardState, type Decision } from '../../engine/src/index.ts';
import { ARENA, arenaBoard, arenaStep, boardAhead, bounced, holdServe, launch, levelScore, levelWinner, percentCleared, sideStatus, type LevelSide } from '../../engine/src/arena.ts';
import { alwaysLanding, clearFast, type StandInPolicy } from '../../jev/src/stand-in.ts';
import { fromResponse, toRequest } from '../../jev/src/wire.ts';

// Does aiming at the objective clear faster? Plays the web game's Jev board
// headless, in game time, as the game plays it now: asked about the board as
// it will stand when the answer lands. Each answer lands --ms later, give or
// take up to --jitter ms drawn from the seed; the seed also drops the
// power-ups, but the brick layout is the same on every seed, so without the
// jitter most seeds play one game. Two stand-in rules answer the same seeds
// through the same wire: `landing`, the rule before docs/scoring.md, and
// `aim`, the rule that follows the new prompt. Then each seed's two boards
// meet as the two sides of a level would. No call leaves this process.
//
//   pnpm objective                 (20 seeds from 20260919, 728 ± 150 ms answers)
//   pnpm objective --seeds 50 --ms 421 --jitter 0
const { values } = parseArgs({
  options: {
    from: { type: 'string', default: '20260919' },
    seeds: { type: 'string', default: '20' },
    ms: { type: 'string', default: '728' },
    jitter: { type: 'string', default: '150' },
  },
});

const TICK_MS = 1000 / ARENA.ticksPerSecond;
const LATE_TICKS = Math.ceil(Number(values.ms) / TICK_MS);
const JITTER_MS = Number(values.jitter);
// The same draw as the engine's: one stream per seed and level, so both rules
// meet the same answer times in the same order.
const lcg = (seed: number) => { let n = seed >>> 0; return () => ((n = Math.imul(1664525, n) + 1013904223) >>> 0) / 4294967296; };
const LEVEL_FRAMES = ARENA.levelSeconds * ARENA.ticksPerSecond;
const SEEDS = Array.from({ length: Number(values.seeds) }, (_, i) => Number(values.from) + i);
const POLICIES = { landing: alwaysLanding, aim: clearFast } as const;
type Name = keyof typeof POLICIES;

// One board, frame by frame, until it clears, runs out of balls or the clock
// ends. `boards[f]` is the board after frame f, so a side that stops early
// stands as it stopped.
type Run = { boards: BoardState[]; clearedAt: number | null; livesLost: number };

function decide(policy: StandInPolicy, state: BoardState, lead: number): Decision {
  const ask = askForDecision(boardAhead(state, lead));
  const request = toRequest(ask, 'stand-in');
  return fromResponse(ask, { answers: { decision: { type: 'choice', choice: policy(request) } } });
}

function play(seed: number, level: number, policy: StandInPolicy): Run {
  let state = arenaBoard(seed, level);
  let serving = true, serveWait = 0, clearedAt: number | null = null;
  let pending: { decision: Decision; landsAt: number } | null = null;
  const boards: BoardState[] = [];
  const draw = lcg(seed * 31 + level);
  for (let frame = 1; frame <= LEVEL_FRAMES && sideStatus(state) === 'playing'; frame++) {
    if (pending && frame >= pending.landsAt) { state = applyDecision(state, pending.decision); pending = null; }
    if (serving) {
      state = holdServe(state);
      if (++serveWait >= ARENA.serveTicks) { state = launch(state); serving = false; serveWait = 0; }
    } else {
      const before = state;
      const { state: next, events } = arenaStep(before);
      state = next;
      if (events.lifeLost) serving = true;
      if (state.completed) clearedAt = frame;
      const due = !serving && !state.completed && (bounced(before, state) || state.tick % ARENA.askEvery === 0);
      if (due && !pending) {
        // Asked ahead by the typical answer time, as the web game leads by its median.
        const late = Math.max(1, Math.ceil((Number(values.ms) + (draw() * 2 - 1) * JITTER_MS) / TICK_MS));
        pending = { decision: decide(policy, state, LATE_TICKS), landsAt: frame + late };
      }
    }
    boards[frame] = state;
  }
  boards[0] = arenaBoard(seed, level);
  return { boards, clearedAt, livesLost: state.livesLost };
}

const at = (run: Run, frame: number) => run.boards[Math.min(frame, run.boards.length - 1)];
const side = (run: Run, end: number): LevelSide => {
  const clearedAt = run.clearedAt !== null && run.clearedAt <= end ? run.clearedAt : null;
  const board = at(run, end);
  return { status: sideStatus(board), clearedAt, levelScore: levelScore(board, clearedAt) };
};
// The frame the level would end on with these two boards as its two sides.
function levelEnd(a: Run, b: Run) {
  const clears = [a.clearedAt, b.clearedAt].filter((f): f is number => f !== null);
  if (clears.length) return Math.min(...clears);
  return Math.min(LEVEL_FRAMES, Math.max(a.boards.length, b.boards.length) - 1);
}

const seconds = (frames: number) => (frames / ARENA.ticksPerSecond).toFixed(1);
const median = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;

console.log(`${SEEDS.length} seeds from ${SEEDS[0]}; answers land ${values.ms} ± ${JITTER_MS} ms after the ask, asked ${LATE_TICKS} ticks ahead; ${ARENA.levels} levels of ${ARENA.levelSeconds} s`);
const totals = { landing: { clears: 0, lost: 0 }, aim: { clears: 0, lost: 0 }, wins: { landing: 0, aim: 0, tie: 0 } };
for (let level = 0; level < ARENA.levels; level++) {
  const runs = Object.fromEntries((Object.keys(POLICIES) as Name[]).map(name => [name, SEEDS.map(seed => play(seed, level, POLICIES[name]))])) as Record<Name, Run[]>;
  const row = (Object.keys(POLICIES) as Name[]).map(name => {
    const clears = runs[name].filter(run => run.clearedAt !== null).map(run => run.clearedAt!);
    const percent = runs[name].map(run => percentCleared(at(run, LEVEL_FRAMES)));
    const lost = runs[name].reduce((n, run) => n + run.livesLost, 0);
    totals[name].clears += clears.length; totals[name].lost += lost;
    const m = median(clears);
    return `${name} cleared ${clears.length}/${SEEDS.length}${m === null ? '' : `, median ${seconds(m)} s`}, ${Math.round(percent.reduce((a, b) => a + b, 0) / percent.length)}% on average, ${lost} balls lost`;
  });
  const wins = { landing: 0, aim: 0, tie: 0 };
  SEEDS.forEach((_, i) => {
    const a = runs.aim[i], l = runs.landing[i], end = levelEnd(a, l);
    const winner = levelWinner(side(a, end), side(l, end));
    wins[winner === 'human' ? 'aim' : winner === 'jev' ? 'landing' : 'tie']++;
  });
  totals.wins.aim += wins.aim; totals.wins.landing += wins.landing; totals.wins.tie += wins.tie;
  console.log(`level ${level + 1}: ${row.join(' | ')}; head to head aim ${wins.aim}, landing ${wins.landing}, tie ${wins.tie}`);
}
const n = SEEDS.length * ARENA.levels;
console.log(`all:     landing cleared ${totals.landing.clears}/${n}, ${totals.landing.lost} balls lost | aim cleared ${totals.aim.clears}/${n}, ${totals.aim.lost} balls lost`);
console.log(`levels won head to head: aim ${totals.wins.aim}, landing ${totals.wins.landing}, tie ${totals.wins.tie}`);
