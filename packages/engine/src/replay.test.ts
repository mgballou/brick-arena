import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { botPlayer, type Ask, type Decision } from './index';
import { compareGhost, replaySession, type RecordedSessionRow } from './replay';

const recordedRows = readFileSync('docs/session.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as RecordedSessionRow);

function rowsFor(player: string, level: number) {
  return recordedRows.filter(row => row.player === player && row.level === level);
}

describe('session replay and ghost comparison', () => {
  it('replays a recorded session to its original final state', () => {
    const cleared = recordedRows.find(row => row.player === 'Human' && row.outcome === 'level-complete')!;
    const rows = rowsFor('Human', cleared.level);
    const replay = replaySession(rows);

    expect(replay.tick).toBe(rows.at(-1)?.tick);
    expect(replay.completed).toBe(true);
    expect(replay).toEqual(rows.at(-1)?.ask.state);
  });

  it('attaches a ghost without changing the replayed world', async () => {
    const rows = rowsFor('Human', 0);
    const withoutGhost = replaySession(rows);
    const comparison = await compareGhost(rows, botPlayer());

    expect(comparison.finalState).toEqual(withoutGhost);
    expect(comparison.opportunities).toBe(rows.length - 1);
  });

  it('reports agreements, divergences, state, and both reaction distributions', async () => {
    const rows = rowsFor('Human', 0).slice(0, 2);
    const ghost = {
      name: 'fixed ghost',
      decide: async (ask: Ask) => ({
        decision: ask.state.tick === 30 ? rows[0].decision : { kind: 'target', x: 80 } as const,
        ms: 17,
      }),
    };

    const report = await compareGhost(rows, ghost);

    expect(report.agreements).toBe(1);
    expect(report.opportunities).toBe(2);
    expect(report.agreementRate).toBe(0.5);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0].state.tick).toBe(60);
    expect(report.originalMs).toEqual([180, 180]);
    expect(report.ghostMs).toEqual([17, 17]);
  });

  it('counts ghost failures and timeouts as missing, never agreement', async () => {
    const rows = rowsFor('Human', 0).slice(0, 2);
    let calls = 0;
    const ghost = {
      name: 'unreliable ghost',
      decide: async (_ask: Ask) => {
        calls++;
        if (calls === 1) throw new Error('failed');
        return new Promise<{ decision: Decision; ms: number }>(() => undefined);
      },
    };

    const report = await compareGhost(rows, ghost, { timeoutMs: 5 });

    expect(report.missingAnswers).toBe(2);
    expect(report.agreements).toBe(0);
    expect(report.agreementRate).toBe(0);
    expect(report.ghostMs).toEqual([]);
    expect(report.finalState).toEqual(replaySession(rows));
  });
});

describe('recording shape', () => {
  it('contains the full replay inputs on every row', () => {
    expect(recordedRows.every(row => row.seed && row.ask?.state && row.decision && typeof row.ms === 'number')).toBe(true);
  });
});
