import { describe, expect, it } from 'vitest';
import { ARENA, arenaBoard, arenaStep, clearBonus, holdServe, launch, levelOver, levelWinner, livesLeft, POINTS, sideStatus } from './arena';
import { applyDecision, createBoard, PADDLE_Y } from './index';

describe('arena board', () => {
  it('narrows the paddle and leaves createBoard as recorded', () => {
    const board = arenaBoard(5, 0);
    expect(board.paddleWidth).toBe(ARENA.paddleWidth);
    expect(board.paddleX + board.paddleWidth / 2).toBe(board.width / 2);
    expect(createBoard(5, 0).paddleWidth).toBe(180);
    expect(arenaBoard(5, 2)).toEqual(arenaBoard(5, 2));
  });
});

describe('serving', () => {
  it('holds the clock and carries the ball on the paddle', () => {
    let board = applyDecision(arenaBoard(1, 0), { kind: 'target', x: 400 });
    for (let i = 0; i < 10; i++) board = holdServe(board);
    expect(board.tick).toBe(0);
    expect(board.paddleX).toBe(180 + 70);
    expect(board.balls[0].x).toBe(board.paddleX + board.paddleWidth / 2);
    expect(board.balls[0].y).toBe(PADDLE_Y - board.balls[0].radius - 1);
  });

  it('launches upward, toward the middle', () => {
    const left = launch(holdServe(applyDecision(arenaBoard(1, 0), { kind: 'target', x: 0 })));
    expect(left.balls[0].vy).toBeLessThan(0);
    expect(left.balls[0].vx).toBeGreaterThan(0);
  });
});

describe('arena step', () => {
  it('scores a brick hit and a break by durability', () => {
    const board = arenaBoard(1, 0);
    const brick = board.bricks.find(item => item.maxDurability === 2)!;
    board.balls[0] = { ...board.balls[0], x: brick.x + 20, y: brick.y + brick.height + 7, vx: 0, vy: -2 };
    const first = arenaStep(board);
    expect(first.events.hits).toEqual([{ x: brick.x + 20, y: brick.y + 9, broke: false, maxDurability: 2 }]);
    expect(first.events.points).toBe(POINTS.hit);

    first.state.balls[0] = { ...first.state.balls[0], x: brick.x + 20, y: brick.y + brick.height + 7, vx: 0, vy: -2 };
    const second = arenaStep(first.state);
    expect(second.events.hits[0].broke).toBe(true);
    expect(second.events.points).toBe(POINTS.hit + 2 * POINTS.breakPerHitPoint);
  });

  it('costs a life only when the last ball falls', () => {
    const board = arenaBoard(1, 0);
    board.balls[0] = { ...board.balls[0], y: board.height + 19, vy: 3 };
    board.balls.push({ ...board.balls[0], id: 'ball-1', y: 100, vy: -2, tracked: false });
    const one = arenaStep(board);
    expect(one.events.lifeLost).toBe(false);
    expect(one.state.livesLost).toBe(0);
    expect(one.state.balls.map(ball => ball.id)).toEqual(['ball-1']);
    expect(one.state.balls[0].tracked).toBe(true);

    one.state.balls[0] = { ...one.state.balls[0], y: board.height + 19, vy: 3 };
    const last = arenaStep(one.state);
    expect(last.events.lifeLost).toBe(true);
    expect(last.state.balls).toHaveLength(1);
    expect(livesLeft(last.state)).toBe(ARENA.lives - 1);
  });

  it('reads a paddle bounce and a caught power-up', () => {
    const board = arenaBoard(1, 0);
    board.balls[0] = { ...board.balls[0], x: 240, y: PADDLE_Y - 8, vx: 0, vy: 3 };
    board.powerUps.push({ id: 'p', kind: 'magnet-paddle', x: 240, y: PADDLE_Y - 2, vy: 1.2 });
    const { events, state } = arenaStep(board);
    expect(events.paddleBounces).toEqual([240]);
    expect(Math.abs(state.balls[0].vx)).toBe(ARENA.minReturnVx);
    expect(events.caught).toEqual(['magnet-paddle']);
    expect(state.magnetPaddle).toBe(true);
  });

  it('is deterministic over a long run', () => {
    const run = () => { let board = arenaBoard(77, 4); for (let i = 0; i < 2000; i++) board = arenaStep(applyDecision(board, { kind: 'target', x: (i * 7) % 480 })).state; return board; };
    expect(run()).toEqual(run());
  });
});

describe('level outcome', () => {
  const side = (status: 'playing' | 'cleared' | 'out', clearedAt: number | null, levelScore: number) => ({ status, clearedAt, levelScore });

  it('ends on a clear, on both sides out, or on the clock', () => {
    expect(levelOver(side('cleared', 10, 0), side('playing', null, 0), 50)).toBe(true);
    expect(levelOver(side('out', null, 0), side('playing', null, 0), 50)).toBe(false);
    expect(levelOver(side('out', null, 0), side('out', null, 0), 50)).toBe(true);
    expect(levelOver(side('playing', null, 0), side('playing', null, 0), 0)).toBe(true);
  });

  it('gives the level to the first clear, then the higher score', () => {
    expect(levelWinner(side('cleared', 900, 10), side('playing', null, 800))).toBe('human');
    expect(levelWinner(side('out', null, 300), side('out', null, 200))).toBe('human');
    expect(levelWinner(side('out', null, 100), side('playing', null, 200))).toBe('jev');
    expect(levelWinner(side('out', null, 100), side('out', null, 100))).toBe('tie');
  });

  it('pays for time left on a clear', () => {
    expect(clearBonus(12.7)).toBe(POINTS.clear + 12 * POINTS.secondLeft);
    expect(sideStatus({ ...arenaBoard(1, 0), livesLost: ARENA.lives })).toBe('out');
  });
});
