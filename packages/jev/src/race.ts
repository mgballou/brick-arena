import { applyDecision, askForDecision, createBoard, step, type Ask, type BoardState, type Decision, type Player } from '../../engine/src/index';

// The board runs at 60 ticks a second and asks every 30 ticks (500 ms), the
// cadence packages/cli/src/session.ts and the web viewer already use.
export const TICK_MS = 1000 / 60;
const ASK_EVERY = 30;

type RaceCall = {
  askedAt: number;
  question: Ask['question'];
  ms: number;
  outcome: 'applied' | 'timeout' | 'error';
  appliedAt: number | null;
  decision: Decision | null;
  error?: string;
};

export type RaceResult = {
  player: string;
  state: BoardState;
  calls: RaceCall[];
  // Ask ticks that passed while an earlier call was still out.
  missedAsks: number[];
};

export type RaceOptions = { seed: number; level: number; maxTicks?: number; deadlineMs?: number; now?: () => number };

class DeadlineError extends Error {}

async function withDeadline<T>(promise: Promise<T>, deadlineMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(`no answer within ${deadlineMs}ms`)), deadlineMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

// Plays one level for one player without ever holding the board for an answer.
// A call's wall-clock time becomes game time: the board keeps stepping on the
// last target for ceil(ms / TICK_MS) ticks, then the answer lands. While a call
// is out, the player misses any ask that comes due. A failed or late call
// applies nothing. Each of these is logged in the result.
export async function raceWithLatency(player: Player, options: RaceOptions): Promise<RaceResult> {
  const maxTicks = options.maxTicks ?? 12000;
  const deadlineMs = options.deadlineMs ?? 1000;
  const now = options.now ?? (() => performance.now());
  let state = createBoard(options.seed, options.level);
  const calls: RaceCall[] = [];
  const missedAsks: number[] = [];
  let pending: { busyUntil: number; call: RaceCall } | null = null;

  while (!state.completed && state.tick < maxTicks) {
    state = step(state);
    if (pending && state.tick >= pending.busyUntil) {
      if (pending.call.decision) {
        state = applyDecision(state, pending.call.decision);
        pending.call.appliedAt = state.tick;
      }
      pending = null;
    }
    if (state.tick % ASK_EVERY !== 0) continue;
    if (pending) {
      missedAsks.push(state.tick);
      continue;
    }

    const ask = askForDecision(state);
    const start = now();
    let call: RaceCall;
    try {
      const answer = await withDeadline(player.decide(ask), deadlineMs);
      call = { askedAt: state.tick, question: ask.question, ms: Math.round(now() - start), outcome: 'applied', appliedAt: null, decision: answer.decision };
    } catch (error) {
      const timedOut = error instanceof DeadlineError;
      call = { askedAt: state.tick, question: ask.question, ms: timedOut ? deadlineMs : Math.round(now() - start), outcome: timedOut ? 'timeout' : 'error', appliedAt: null, decision: null, error: error instanceof Error ? error.message : String(error) };
    }
    calls.push(call);
    const lateTicks = Math.ceil(call.ms / TICK_MS);
    if (lateTicks === 0 && call.decision) {
      state = applyDecision(state, call.decision);
      call.appliedAt = state.tick;
    } else if (lateTicks > 0) {
      pending = { busyUntil: state.tick + lateTicks, call };
    }
  }
  return { player: player.name, state, calls, missedAsks };
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

export function summarize(result: RaceResult) {
  const ms = result.calls.map(call => call.ms).sort((a, b) => a - b);
  const applied = result.calls.filter(call => call.appliedAt !== null);
  return {
    player: result.player,
    finished: result.state.completed,
    ticks: result.state.tick,
    bricksCleared: result.state.bricksCleared,
    livesLost: result.state.livesLost,
    calls: result.calls.length,
    applied: applied.length,
    timeouts: result.calls.filter(call => call.outcome === 'timeout').length,
    errors: result.calls.filter(call => call.outcome === 'error').length,
    missedAsks: result.missedAsks.length,
    lateTicks: applied.reduce((total, call) => total + (call.appliedAt! - call.askedAt), 0),
    msMedian: pct(ms, 0.5),
    msP95: pct(ms, 0.95),
    msMax: ms.at(-1) ?? 0,
  };
}
