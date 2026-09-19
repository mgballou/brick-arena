import { describe, expect, it } from 'vitest';
import { applyDecision, askForDecision, createBoard, predictPaddleX, step } from './index';
describe('pure deterministic board', () => {
  it('creates identical levels from one seed', () => expect(createBoard(7, 4)).toEqual(createBoard(7, 4)));
  it('replays a scripted player exactly from one seed', () => { const play = () => { let state = createBoard(91, 3); for (let i = 0; i < 240; i++) state = step(applyDecision(state, { kind: 'target', x: 240 })); return state; }; expect(play()).toEqual(play()); });
  it('replays a logged session to the identical final state', () => {
    let state = createBoard(92, 0); const log = [] as Array<{ tick: number; ask: ReturnType<typeof askForDecision>; decision: Parameters<typeof applyDecision>[1] }>;
    for (let i = 0; i < 120; i++) { state = step(state); if (state.tick % 30 === 0) { const ask = askForDecision(state), decision = { kind: 'target', x: Number(ask.options[0]) } as const; log.push({ tick: state.tick, ask, decision }); state = applyDecision(state, decision); } }
    let replay = createBoard(92, 0);
    for (const record of log) { while (replay.tick < record.tick) replay = step(replay); expect(record.ask).toEqual(askForDecision(replay)); replay = applyDecision(replay, record.decision); }
    expect(replay).toEqual(state);
  });
  it('exposes five different level decisions', () => { const boards = [0, 1, 2, 3, 4].map(level => createBoard(1, level)); expect(boards.map(board => board.bricks.filter(brick => brick.unbreakable).length)).toEqual([0, 10, 32, 0, 4]); expect(boards[3].bricks.some(brick => brick.regenerates)).toBe(true); expect(boards[4].bricks.some(brick => brick.maxDurability === 3)).toBe(true); });
  it('offers categorical chase and track decisions', () => { let state = createBoard(2, 4); state.powerUps.push({ id: 'p', kind: 'short-paddle', x: 80, y: 100, vy: 1.2 }); expect(askForDecision(state).question).toBe('chase'); state = applyDecision(state, { kind: 'chase', powerUpId: 'p' }); state.balls.push({ ...state.balls[0], id: 'ball-1', tracked: false }); state.powerUps = []; expect(askForDecision(state).question).toBe('track'); });
  it('reflects a predicted wall path', () => expect(predictPaddleX({ id: 'b', x: 470, y: 100, vx: 3, vy: 2, radius: 6, tracked: true, piercing: false })).toBeCloseTo(199));
  it('steps without I/O and does not mutate completed worlds', () => { let state = applyDecision(createBoard(1), { kind: 'target', x: 240 }); expect(step(state).tick).toBe(1); state.completed = true; expect(step(state)).toEqual(state); });
});
