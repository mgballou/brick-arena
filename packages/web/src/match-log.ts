import { percentCleared, livesLeft } from '../../engine/src/arena';
import type { Ask, BoardState } from '../../engine/src/index';
import { toRequest } from '../../jev/src/wire';
import { MATCHES_PATH, newMatchId, RECORD_VERSION, type JevOutcome, type MatchLine, type RecordSide, type SentState, type SideTotal } from '../../server/src/record';

// The browser's half of the match record (packages/server/src/record.ts): the
// game builds each line with these, and a MatchLog sends them to the server
// every few seconds. Recording never touches play: a write that fails is
// dropped, and after a refusal the log stops sending.
export const FLUSH_MS = 5000;

const round = (value: unknown): unknown => {
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, round(item)]));
  return value;
};

// The board as Jev was sent it, with the bricks as one character each.
export function sentState(ask: Ask): SentState {
  const { bricks: _, ...rest } = toRequest(ask, 'jev').state as Record<string, unknown>;
  const bricks = ask.state.bricks.map(brick => brick.unbreakable ? '#' : String(Math.min(9, brick.durability))).join('');
  return { ...(round(rest) as Record<string, unknown>), bricks };
}

export function sideTotal(state: BoardState, score: number): SideTotal {
  return { score, percent: percentCleared(state), bricksLeft: state.bricks.filter(brick => !brick.unbreakable && brick.durability > 0).length, livesLeft: livesLeft(state) };
}

export function jevLine(at: { level: number; frame: number; tick: number; lead: number }, ask: Ask, outcome: JevOutcome, ms: number, choice?: string): MatchLine {
  return { type: 'jev', ...at, question: ask.question, options: ask.options.map(option => round(option) as string | number), state: sentState(ask), outcome, ...(choice === undefined ? {} : { choice }), ms };
}

// Every ball that left the board on a step, from `arenaStep`'s events.
export function lostLines(at: { level: number; frame: number; side: RecordSide }, lost: number[], lifeLost: boolean, after: BoardState): MatchLine[] {
  return lost.map((x, i) => ({ type: 'lost', ...at, x: Math.round(x), lifeLost: lifeLost && i === lost.length - 1, livesLeft: livesLeft(after) }));
}

export type Sender = (id: string, body: string, last: boolean) => Promise<boolean>;

// Same origin, like /api/jev. The last write of a closing page goes as a
// beacon, which the browser finishes after the page is gone. The others are
// plain POSTs: Chrome allows a page 64 KiB of keepalive and beacon bodies in
// all, and a keepalive write past it never settled, which held back every
// write after it (match-log.test.ts).
export const sendToServer: Sender = async (id, body, last) => {
  const url = `${MATCHES_PATH}/${id}`;
  if (last && typeof navigator !== 'undefined' && navigator.sendBeacon) return navigator.sendBeacon(url, new Blob([body], { type: 'application/x-ndjson' }));
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body });
    return response.ok;
  } catch {
    return false;
  }
};

export class MatchLog {
  readonly id: string;
  private pending: MatchLine[] = [];
  private sending: Promise<void> = Promise.resolve();
  private stopped = false;
  private ended = false;

  constructor(start: { seed: number; tuning: string; opponent: 'live' | 'stand-in'; debug: boolean }, private readonly send: Sender = sendToServer, now = new Date()) {
    this.id = newMatchId(now);
    this.pending.push({ type: 'start', v: RECORD_VERSION, id: this.id, at: now.toISOString(), ...start });
  }

  write(line: MatchLine) {
    if (!this.ended) this.pending.push(line);
  }

  // The match is over, one way or another; later lines are dropped.
  end(reason: 'final' | 'down' | 'left', human: number, jev: number) {
    if (this.ended) return;
    this.write({ type: 'end', at: new Date().toISOString(), reason, human, jev });
    this.ended = true;
  }

  get done() { return this.ended; }

  // Writes are sent one at a time, in order, so the server sees `start` first.
  flush(last = false): Promise<void> {
    if (this.stopped || !this.pending.length) return this.sending;
    const lines = this.pending;
    this.pending = [];
    const body = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
    if (last) { void this.send(this.id, body, true); return this.sending; }
    this.sending = this.sending.then(async () => {
      if (this.stopped) return;
      if (!await this.send(this.id, body, false)) this.stopped = true;
    });
    return this.sending;
  }
}
