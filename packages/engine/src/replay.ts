import { applyDecision, askForDecision, createBoard, step, type Ask, type BoardState, type Decision, type DecisionRecord, type Player } from './index';

export type RecordedSessionRow = DecisionRecord & { player: string; level: number };

type Divergence = {
  tick: number;
  state: BoardState;
  recorded: Decision;
  ghost: Decision;
};

export type GhostComparison = {
  finalState: BoardState;
  opportunities: number;
  agreements: number;
  agreementRate: number;
  missingAnswers: number;
  divergences: Divergence[];
  originalMs: number[];
  ghostMs: number[];
};

export type GhostOptions = { timeoutMs?: number };

const terminalOutcomes = new Set(['level-complete', 'time-limit']);
const isDecisionRow = (row: RecordedSessionRow) => !terminalOutcomes.has(row.outcome);

function decisionRows(rows: readonly RecordedSessionRow[]) {
  return rows.filter(isDecisionRow);
}

function assertSession(rows: readonly RecordedSessionRow[]) {
  if (!rows.length) throw new Error('Cannot replay an empty session');
  const first = rows[0];
  for (const row of rows) {
    if (row.seed !== first.seed || row.level !== first.level) throw new Error('A replay must contain one seed and level');
  }
}

function stateAtRow(state: BoardState, row: RecordedSessionRow) {
  while (state.tick < row.tick) state = step(state);
  if (state.tick !== row.tick) throw new Error(`Replay row ${row.tick} is behind the current tick ${state.tick}`);
  const actualAsk = askForDecision(state);
  if (JSON.stringify(actualAsk) !== JSON.stringify(row.ask)) throw new Error(`Replay diverged before tick ${row.tick}`);
  return state;
}

export function replaySession(rows: readonly RecordedSessionRow[]): BoardState {
  assertSession(rows);
  let state = createBoard(rows[0].seed, rows[0].level);
  for (const row of decisionRows(rows)) {
    state = stateAtRow(state, row);
    state = applyDecision(state, row.decision);
  }
  const terminal = rows.at(-1);
  if (terminal && terminalOutcomes.has(terminal.outcome)) state = stateAtRow(state, terminal);
  return state;
}

function sameDecision(left: Decision, right: Decision) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ghost decision timed out')), timeoutMs)),
  ]);
}

export async function compareGhost(rows: readonly RecordedSessionRow[], ghost: Player, options: GhostOptions = {}): Promise<GhostComparison> {
  assertSession(rows);
  const opportunities = decisionRows(rows);
  let state = createBoard(rows[0].seed, rows[0].level);
  let agreements = 0;
  let missingAnswers = 0;
  const divergences: Divergence[] = [];
  const originalMs: number[] = [];
  const ghostMs: number[] = [];
  const timeoutMs = options.timeoutMs ?? 1000;

  for (const row of opportunities) {
    state = stateAtRow(state, row);
    originalMs.push(row.ms);
    try {
      const answer = await withTimeout(ghost.decide(row.ask), timeoutMs);
      ghostMs.push(answer.ms);
      if (sameDecision(row.decision, answer.decision)) agreements++;
      else divergences.push({ tick: row.tick, state: row.ask.state, recorded: row.decision, ghost: answer.decision });
    } catch {
      missingAnswers++;
    }
    state = applyDecision(state, row.decision);
  }

  const terminal = rows.at(-1);
  if (terminal && terminalOutcomes.has(terminal.outcome)) state = stateAtRow(state, terminal);
  return { finalState: state, opportunities: opportunities.length, agreements, agreementRate: opportunities.length ? agreements / opportunities.length : 0, missingAnswers, divergences, originalMs, ghostMs };
}
