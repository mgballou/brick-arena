import { describe, expect, it } from 'vitest';
import { summarize, tallyJev, tallyLine, tallyRows, type MatchLine } from './record';

const call = (question: 'target' | 'chase' | 'track', outcome: Extract<MatchLine, { type: 'jev' }>['outcome'], choice?: string): MatchLine =>
  ({ type: 'jev', level: 0, frame: 0, tick: 0, lead: 0, question, options: [], state: { bricks: '' }, outcome, ...(choice === undefined ? {} : { choice }), ms: 700 });

// Seven calls: four target catches answered (aim twice), one aim too late for
// its level, a chase, a track, a timeout and a choice no option names.
const calls: MatchLine[] = [
  call('target', 'answered', 'aim'),
  call('target', 'answered', 'landing'),
  call('chase', 'answered', 'p3'),
  call('target', 'answered', 'aim'),
  call('target', 'timeout'),
  call('target', 'stale', 'aim'),
  call('track', 'answered', 'b2'),
  call('target', 'answered', 'angle-left'),
  call('target', 'answered', 'toString'),
];

describe("Jev's tally", () => {
  it('counts every call and every target catch, not only the last', () => {
    expect(tallyJev(calls)).toEqual({
      calls: 9,
      answered: 7,
      stale: 1,
      missed: 1,
      questions: { target: 7, chase: 1, track: 1 },
      target: { landing: 1, aim: 3, 'angle-left': 1, 'angle-right': 0 },
    });
  });

  it('is part of the match summary', () => {
    const start: MatchLine = { type: 'start', v: 1, id: '20260926-100000-abcdef', at: '2026-09-26T10:00:00Z', seed: 1, tuning: 'standard', opponent: 'stand-in', debug: true };
    expect(summarize([start, ...calls])!.jev).toEqual(tallyJev(calls));
  });

  it('reads as aimed against played safe', () => {
    const tally = tallyJev(calls);
    expect(tallyRows(tally, 'Stand-in')).toEqual([
      'Stand-in: 9 calls, 7 answered, 1 too late for its level, 1 not answered',
      'Target catches: 5 chosen, aim 3 (60%), landing 1 (20%), angle-left 1 (20%), angle-right 0',
      'Aimed 3, played safe 1, angled 1',
      'Other questions: chase 1, track 1',
    ]);
    expect(tallyLine(tally)).toBe('9 calls, aimed 3 of 5 catches, safe 1');
  });

  it('says so when a match has no calls', () => {
    const tally = tallyJev([]);
    expect(tallyRows(tally, 'Jev')).toEqual(['Jev: no calls']);
    expect(tallyLine(tally)).toBe('no calls');
  });
});
