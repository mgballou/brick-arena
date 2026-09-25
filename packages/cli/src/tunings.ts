import { parseArgs } from 'node:util';
import { applyDecision, askForDecision, predictPaddleX, type BoardState, type Decision } from '../../engine/src/index.ts';
import { ARENA, arenaBoard, arenaStep, boardAhead, bounced, holdServe, isTuningName, launch, sideStatus, TUNINGS, type Tuning, type TuningName } from '../../engine/src/arena.ts';
import { standInChoice } from '../../jev/src/stand-in.ts';
import { fromResponse, toRequest } from '../../jev/src/wire.ts';

// How long does a level take to clear under each tuning? Plays every level
// headless, in game time, on fixed seeds, for the full clock or until the
// board clears or runs out of balls. Three players, each alone on a board:
//   jev    the stand-in as the game plays it, asked about the board as it will
//          stand when its answer lands, once for each answer time in --ms
//   aim    the stand-in's rule answering in --react ms: a player who aims
//          every catch at the densest bricks
//   keys   a player on the arrow keys who sees the board --react ms late and
//          only catches, never aims
// Seeds change only which power-ups fall, so the answer times give most of
// the spread.
//
//   pnpm tunings
//   pnpm tunings --tuning angled --seeds 3 --ms 728
const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '20260919' },
    seeds: { type: 'string', default: '5' },
    tuning: { type: 'string' },
    ms: { type: 'string', default: '500,728,1000' },
    react: { type: 'string', default: '200' },
  },
});

if (values.tuning !== undefined && !isTuningName(values.tuning)) throw new Error(`no tuning "${values.tuning}"; there are ${Object.keys(TUNINGS).join(', ')}`);
const SEEDS = Array.from({ length: Number(values.seeds) }, (_, i) => Number(values.seed) + i);
const TICK_MS = 1000 / ARENA.ticksPerSecond;
const JEV_FRAMES = values.ms.split(',').map(ms => Math.ceil(Number(ms) / TICK_MS));
const REACT_FRAMES = Math.round(Number(values.react) / TICK_MS);
const LEVEL_FRAMES = ARENA.levelSeconds * ARENA.ticksPerSecond;

type Who = { kind: 'stand-in'; frames: number } | { kind: 'keys' };
type Result = { clearedAt: number | null; livesLost: number; percent: number };

function standIn(state: BoardState, frames: number, tuning: Tuning): Decision {
  const ask = askForDecision(boardAhead(state, frames, tuning));
  const choice = standInChoice(toRequest(ask, 'stand-in'));
  return fromResponse(ask, { answers: { decision: { type: 'choice', choice } } });
}

// Arrow keys toward where the lowest falling ball will land, as seen `REACT_FRAMES` ago.
function keysTarget(seen: BoardState, now: BoardState): Decision {
  const center = now.paddleX + now.paddleWidth / 2;
  const falling = seen.balls.filter(ball => ball.vy > 0).sort((a, b) => b.y - a.y)[0];
  const goal = falling ? predictPaddleX(falling) : seen.balls[0].x;
  const gap = goal - center;
  return { kind: 'target', x: Math.abs(gap) < 6 ? center : center + Math.sign(gap) * 80 };
}

function hitPointsShare(state: BoardState) {
  let total = 0, left = 0;
  for (const brick of state.bricks) if (!brick.unbreakable) { total += brick.maxDurability; left += brick.durability; }
  return total ? Math.floor((100 * (total - left)) / total) : 100;
}

function play(seed: number, level: number, who: Who, tuning: Tuning): Result {
  let state = arenaBoard(seed, level, tuning);
  let serving = true, serveWait = 0, frame = 0;
  let pending: { decision: Decision; landsAt: number } | null = null;
  const seen: BoardState[] = [];

  for (; frame < LEVEL_FRAMES && sideStatus(state) === 'playing'; frame++) {
    if (pending && frame >= pending.landsAt) {
      state = applyDecision(state, pending.decision);
      pending = null;
    }
    if (who.kind === 'keys') {
      seen.push(state);
      if (seen.length > REACT_FRAMES + 1) seen.shift();
      state = applyDecision(state, keysTarget(seen[0], state));
    }
    if (serving) {
      state = holdServe(state);
      if (++serveWait >= ARENA.serveTicks) { state = launch(state); serving = false; serveWait = 0; }
      continue;
    }
    const before = state;
    const { state: next, events } = arenaStep(before, tuning);
    state = next;
    if (events.lifeLost) serving = true;
    const due = !serving && !state.completed && (bounced(before, state) || state.tick % ARENA.askEvery === 0);
    if (who.kind === 'stand-in' && due && !pending) pending = { decision: standIn(state, who.frames, tuning), landsAt: frame + who.frames };
  }
  return { clearedAt: state.completed ? frame : null, livesLost: state.livesLost, percent: hitPointsShare(state) };
}

const seconds = (frames: number) => (frames / ARENA.ticksPerSecond).toFixed(1);
const median = (list: number[]) => { const s = [...list].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

function describe(results: Result[]) {
  const clears = results.flatMap(r => (r.clearedAt === null ? [] : [r.clearedAt]));
  const lost = results.reduce((sum, r) => sum + r.livesLost, 0);
  const share = median(results.map(r => r.percent));
  const time = clears.length ? `median ${seconds(median(clears))} s, fastest ${seconds(Math.min(...clears))} s` : `none; median ${share}% cleared`;
  return `${clears.length}/${results.length} cleared (${time}); ${lost} balls lost`;
}

const names = values.tuning ? [values.tuning as TuningName] : (Object.keys(TUNINGS) as TuningName[]);
const PLAYERS: Array<[string, Who[]]> = [
  ['jev', JEV_FRAMES.map(frames => ({ kind: 'stand-in', frames }))],
  ['aim', [{ kind: 'stand-in', frames: REACT_FRAMES }]],
  ['keys', [{ kind: 'keys' }]],
];
const show = (tuning: Tuning) => Object.entries(tuning).map(([key, value]) => `${key} ${value}`).join(', ');

console.log(`seeds ${SEEDS[0]}–${SEEDS.at(-1)}; jev answers in ${values.ms} ms; aim and keys react in ${values.react} ms; ${ARENA.levels} levels of ${ARENA.levelSeconds} s`);
for (const name of names) {
  const tuning = TUNINGS[name];
  console.log(`\n${name}: ${show(tuning)}`);
  for (let level = 0; level < ARENA.levels; level++) {
    const row = PLAYERS.map(([label, whos]) => `${label} ${describe(whos.flatMap(who => SEEDS.map(seed => play(seed, level, who, tuning))))}`);
    console.log(`  level ${level + 1}: ${row.join(' | ')}`);
  }
}
