import { levelNames } from '../../engine/src/index.ts';
import { targetKeys } from '../../jev/src/wire.ts';

// The record of one match of the web game, as the hosted server keeps it: one
// NDJSON file per match, appended to as the match plays and never rewritten.
// The browser writes the lines (packages/web/src/match-log.ts), the server
// appends them (matches.ts), and `pnpm match` and /matches.html read them.
// It holds the game and nothing about who played it.
//
// `frame` counts ticks of the level clock, 60 a second; 0 until the countdown
// runs out. `side` is the board: `human` is you, `jev` is Jev (or, in debug
// mode, the stand-in, which `start.opponent` names).

export const RECORD_VERSION = 1;
// Where the browser sends a match and the page reads it back (matches.ts).
export const MATCHES_PATH = '/api/matches';

export type RecordSide = 'human' | 'jev';
export type SideTotal = { score: number; percent: number; bricksLeft: number; livesLeft: number };

// What Jev was sent, less the words: the board as `toRequest` put it, rounded
// to hundredths, with `bricks` as one character per brick in `createBoard`'s
// order: a digit for the hit points left (0 is broken), `#` for unbreakable.
export type SentState = Record<string, unknown> & { bricks: string };

// `answered`: the choice moved the paddle. `stale`: it came back after the
// level it was asked on had ended. The rest are the browser's failures
// (packages/web/src/jev.ts); a `down` on the level in play ends the match.
export type JevOutcome = 'answered' | 'stale' | 'timeout' | 'bad-answer' | 'offline' | 'down';

export type MatchLine =
  | { type: 'start'; v: number; id: string; at: string; seed: number; tuning: string; opponent: 'live' | 'stand-in'; debug: boolean }
  | { type: 'level'; level: number; name: string }
  // `first` is the level's first ball, which both sides launch together when
  // the countdown runs out; after a lost ball each side serves its own.
  | { type: 'launch'; level: number; frame: number; side: RecordSide; x: number; first: boolean }
  // `x` is where the ball left the board. Only the last ball in play costs a
  // life; when two go on one step, the second line carries it.
  | { type: 'lost'; level: number; frame: number; side: RecordSide; x: number; lifeLost: boolean; livesLeft: number }
  // Once a second of the level clock, and once more when the level ends.
  | { type: 'progress'; level: number; frame: number; human: SideTotal; jev: SideTotal }
  // One call to Jev. `tick` is the board on screen when it was asked; `lead` is
  // how many ticks ahead the board it was sent stood (`boardAhead`).
  | { type: 'jev'; level: number; frame: number; tick: number; lead: number; question: 'target' | 'chase' | 'track'; options: Array<string | number>; state: SentState; outcome: JevOutcome; choice?: string; ms: number }
  | { type: 'levelEnd'; level: number; frame: number; winner: 'human' | 'jev' | 'tie'; human: SideTotal & { cleared: boolean }; jev: SideTotal & { cleared: boolean } }
  // `final`: all levels played. `down`: Jev went down and the page left the
  // board. `left`: the page closed or went back to the title mid-match.
  | { type: 'end'; at: string; reason: 'final' | 'down' | 'left'; human: number; jev: number };

type LineType = MatchLine['type'];
const LINE_TYPES: ReadonlySet<string> = new Set<LineType>(['start', 'level', 'launch', 'lost', 'progress', 'jev', 'levelEnd', 'end']);

// A match id is its UTC start and six random letters, so names sort by time:
// 20260926-143205-k3m9qa.
const ID = /^\d{8}-\d{6}-[a-z0-9]{6}$/;
export const isMatchId = (id: string) => ID.test(id);
// When the id says the match began, in milliseconds since 1970.
export const idTime = (id: string) => Date.parse(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`);

export function newMatchId(now = new Date(), random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const letters = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('');
  return `${stamp}-${letters}`;
}

// One line as the server accepts it: a JSON object of a known type. Anything
// else is refused whole, so a file holds only lines a reader understands.
export function parseLine(text: string): MatchLine | null {
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) && LINE_TYPES.has(value.type) ? value as MatchLine : null;
  } catch {
    return null;
  }
}

export function parseRecord(text: string): MatchLine[] {
  return text.split('\n').filter(Boolean).map(parseLine).filter((line): line is MatchLine => line !== null);
}

export type MatchSummary = {
  id: string;
  at: string;
  tuning: string;
  opponent: 'live' | 'stand-in';
  debug: boolean;
  levels: Array<{ level: number; winner: 'human' | 'jev' | 'tie' | null }>;
  ballsLost: Record<RecordSide, number>;
  jev: JevTally;
  // Null while the match is still playing, or if the page closed before it could say.
  end: { reason: 'final' | 'down' | 'left'; human: number; jev: number } | null;
};

// Every call to Jev in a match, and what it chose. A choice that came back too
// late for its level (`stale`) still counts: it is what Jev picked. `target`
// counts the four catches of `targetKeys`; `aim` is the aimed catch and
// `landing` the safe one (docs/scoring.md).
type TargetKey = typeof targetKeys[number];
export type JevTally = {
  calls: number;
  answered: number;
  stale: number;
  missed: number;
  questions: Record<'target' | 'chase' | 'track', number>;
  target: Record<TargetKey, number>;
};

const blankTally = (): JevTally => ({ calls: 0, answered: 0, stale: 0, missed: 0, questions: { target: 0, chase: 0, track: 0 }, target: { landing: 0, aim: 0, 'angle-left': 0, 'angle-right': 0 } });

// Anyone can write a record, so only the known questions and catches count.
function foldTally(tally: JevTally, line: Extract<MatchLine, { type: 'jev' }>) {
  tally.calls++;
  if (line.outcome === 'answered') tally.answered++;
  else if (line.outcome === 'stale') tally.stale++;
  else tally.missed++;
  if (Object.hasOwn(tally.questions, line.question)) tally.questions[line.question]++;
  const choice = line.question === 'target' && (line.outcome === 'answered' || line.outcome === 'stale') ? line.choice : undefined;
  if (typeof choice === 'string' && (targetKeys as readonly string[]).includes(choice)) tally.target[choice as TargetKey]++;
}

export function tallyJev(lines: MatchLine[]): JevTally {
  const tally = blankTally();
  for (const line of lines) if (line.type === 'jev') foldTally(tally, line);
  return tally;
}

const caught = (tally: JevTally) => targetKeys.reduce((sum, key) => sum + tally.target[key], 0);
const share = (count: number, of: number) => count && of ? ` (${Math.round(count / of * 100)}%)` : '';

// The tally as rows a person reads, under `pnpm match <id>` and on the page.
export function tallyRows(tally: JevTally, opponent = 'Jev'): string[] {
  if (!tally.calls) return [`${opponent}: no calls`];
  const chosen = caught(tally);
  const byCount = [...targetKeys].sort((a, b) => tally.target[b] - tally.target[a] || targetKeys.indexOf(a) - targetKeys.indexOf(b));
  return [
    `${opponent}: ${tally.calls} calls, ${tally.answered} answered, ${tally.stale} too late for its level, ${tally.missed} not answered`,
    `Target catches: ${chosen} chosen, ${byCount.map(key => `${key} ${tally.target[key]}${share(tally.target[key], chosen)}`).join(', ')}`,
    `Aimed ${tally.target.aim}, played safe ${tally.target.landing}, angled ${tally.target['angle-left'] + tally.target['angle-right']}`,
    `Other questions: chase ${tally.questions.chase}, track ${tally.questions.track}`,
  ];
}

// The tally in a few words, for one match's line in a list.
export const tallyLine = (tally: JevTally) =>
  tally.calls ? `${tally.calls} calls, aimed ${tally.target.aim} of ${caught(tally)} catches, safe ${tally.target.landing}` : 'no calls';

export const startSummary = (start: Extract<MatchLine, { type: 'start' }>): MatchSummary =>
  ({ id: start.id, at: start.at, tuning: start.tuning, opponent: start.opponent, debug: start.debug, levels: [], ballsLost: { human: 0, jev: 0 }, jev: blankTally(), end: null });

// One more line into a summary, so the server can keep each match's summary
// up to date as lines arrive.
export function foldSummary(summary: MatchSummary, line: MatchLine) {
  if (line.type === 'level') summary.levels.push({ level: line.level, winner: null });
  if (line.type === 'lost' && (line.side === 'human' || line.side === 'jev')) summary.ballsLost[line.side]++;
  if (line.type === 'jev') foldTally(summary.jev, line);
  if (line.type === 'levelEnd') {
    const level = summary.levels.find(item => item.level === line.level);
    if (level) level.winner = line.winner;
    else summary.levels.push({ level: line.level, winner: line.winner });
  }
  if (line.type === 'end') summary.end = { reason: line.reason, human: line.human, jev: line.jev };
}

export function summarize(lines: MatchLine[]): MatchSummary | null {
  const start = lines.find(line => line.type === 'start');
  if (!start || start.type !== 'start') return null;
  const summary = startSummary(start);
  for (const line of lines) foldSummary(summary, line);
  return summary;
}

// Each line as one row a person reads: the CLI prints these and the page
// lists them. `time` is the level clock, `m:ss.s`.
type Row = { level: number | null; time: string; side: RecordSide | null; text: string };

const WHO: Record<RecordSide, string> = { human: 'You', jev: 'Jev' };
export const levelTitle = (level: number) => `Level ${level + 1}, ${levelNames[level] ?? '?'}`;
export const clockOf = (frame: number) => {
  const tenths = Math.round(frame / 6);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
};
const total = (side: SideTotal) => `${side.percent}% cleared, ${side.livesLeft} ${side.livesLeft === 1 ? 'ball' : 'balls'} left, ${side.score} points`;

export function describe(line: MatchLine, opponent = 'Jev'): Row {
  const who = (side: RecordSide) => side === 'jev' ? opponent : WHO[side];
  const at = (level: number, frame: number, side: RecordSide | null, text: string): Row => ({ level, time: clockOf(frame), side, text });
  switch (line.type) {
    case 'start':
      return { level: null, time: '', side: null, text: `Match ${line.id} at ${line.at}: seed ${line.seed}, tuning ${line.tuning}, against ${line.opponent === 'live' ? 'live Jev' : 'the stand-in'}${line.debug ? ' (debug)' : ''}` };
    case 'level':
      return at(line.level, 0, null, `${levelTitle(line.level)} begins`);
    case 'launch':
      return at(line.level, line.frame, line.side, `${who(line.side)} launched at x=${Math.round(line.x)}${line.first ? ' (the countdown)' : ''}`);
    case 'lost':
      return at(line.level, line.frame, line.side, `${who(line.side)} lost a ball at x=${Math.round(line.x)}${line.lifeLost ? `: ${line.livesLeft} ${line.livesLeft === 1 ? 'ball' : 'balls'} left` : ', no life lost'}`);
    case 'progress':
      return at(line.level, line.frame, null, `You ${line.human.percent}%, ${opponent} ${line.jev.percent}%`);
    case 'jev': {
      const answer = line.outcome === 'answered' ? `chose ${line.choice}` : line.outcome === 'stale' ? `chose ${line.choice}, too late for the level` : line.outcome;
      return at(line.level, line.frame, 'jev', `${opponent} asked ${line.question} [${line.options.join(', ')}]: ${answer} (${line.ms} ms, ${line.lead} ticks ahead)`);
    }
    case 'levelEnd': {
      const won = line.winner === 'tie' ? 'a tie' : `${who(line.winner)} won`;
      return at(line.level, line.frame, null, `${levelTitle(line.level)} over, ${won}. You: ${total(line.human)}${line.human.cleared ? ', cleared' : ''}. ${opponent}: ${total(line.jev)}${line.jev.cleared ? ', cleared' : ''}`);
    }
    case 'end':
      return { level: null, time: '', side: null, text: `Match ${line.reason === 'final' ? 'over' : line.reason === 'down' ? 'ended: Jev went down' : 'left unfinished'} at ${line.at}. You ${line.human}, ${opponent} ${line.jev}` };
  }
}

// The record as text, one row a line. Progress lines are left out unless asked
// for, since they come once a second.
export function timeline(lines: MatchLine[], options: { progress?: boolean; state?: boolean } = {}): string[] {
  const start = lines.find(line => line.type === 'start');
  const opponent = start?.type === 'start' && start.opponent === 'stand-in' ? 'Stand-in' : 'Jev';
  const out: string[] = [];
  for (const line of lines) {
    if (line.type === 'progress' && !options.progress) continue;
    const row = describe(line, opponent);
    const where = row.level === null ? '' : `L${row.level + 1} ${row.time.padStart(7)}  `;
    out.push(`${where}${row.text}`);
    if (line.type === 'jev' && options.state) out.push(`    ${JSON.stringify(line.state)}`);
  }
  return out;
}
