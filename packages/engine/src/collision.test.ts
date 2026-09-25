import { describe, expect, it } from 'vitest';
import { createBoard, step, type Ball, type BoardState, type Brick } from './index';

const brick = (id: string, x: number, y: number, extra: Partial<Brick> = {}): Brick => ({ id, x, y, width: 40, height: 18, durability: 1, maxDurability: 1, unbreakable: false, regenerates: false, lastDamagedTick: 0, ...extra });
const wall = (id: string, x: number, y: number) => brick(id, x, y, { unbreakable: true });

// A board holding only the given bricks and one ball. A breakable brick far off
// in the top corner keeps the level from counting as complete.
function board(bricks: Brick[], ball: Partial<Ball>): BoardState {
  const state = createBoard(1, 0);
  state.bricks = [...bricks, brick('keep', 430, 30)];
  state.balls = [{ ...state.balls[0], ...ball }];
  return state;
}

// Strict overlap: a ball resting against a face is outside the brick.
const inside = (ball: Ball, rect: Brick) => ball.x + ball.radius > rect.x && ball.x - ball.radius < rect.x + rect.width && ball.y + ball.radius > rect.y && ball.y - ball.radius < rect.y + rect.height;

function run(state: BoardState, ticks: number) {
  const states = [state];
  for (let i = 0; i < ticks; i++) states.push(step(states.at(-1)!));
  return states;
}

describe('ball against bricks', () => {
  it('bounces a side hit off an unbreakable brick sideways and keeps it out', () => {
    const states = run(board([wall('wall', 200, 100)], { x: 190, y: 109, vx: 3, vy: -0.6 }), 12);
    for (const state of states) expect(inside(state.balls[0], state.bricks[0])).toBe(false);
    const ball = states.at(-1)!.balls[0];
    expect(ball.vx).toBe(-3);
    expect(ball.vy).toBe(-0.6);
    expect(ball.x + ball.radius).toBeLessThanOrEqual(200);
  });

  it('turns both ways in the corner between a breakable brick and an unbreakable one', () => {
    const roof = brick('roof', 100, 100, { durability: 2, maxDurability: 2 }), side = wall('side', 144, 122);
    const states = run(board([roof, side], { x: 133, y: 128, vx: 2, vy: -2 }), 12);
    for (const state of states) for (const item of state.bricks.slice(0, 2)) expect(inside(state.balls[0], item)).toBe(false);
    const last = states.at(-1)!;
    expect(last.balls[0].vx).toBe(-2);
    expect(last.balls[0].vy).toBe(2);
    expect(last.bricks[0].durability).toBe(1);
    expect(last.bricks[1].durability).toBe(1);
  });

  it('stops a fast ball at an unbreakable row instead of letting it through', () => {
    const row = [wall('a', 100, 100), wall('b', 144, 100), wall('c', 188, 100)];
    const [, after] = run(board(row, { x: 164, y: 140, vx: 0.5, vy: -50 }), 1);
    const ball = after.balls[0];
    expect(ball.vy).toBe(50);
    expect(ball.y - ball.radius).toBeGreaterThanOrEqual(118);
    expect(ball.y).toBeCloseTo(124 + (50 - 16));
  });

  it('bounces a head-on top hit straight back, from the face it touched', () => {
    const states = run(board([wall('wall', 200, 100)], { x: 220, y: 88, vx: 0.5, vy: 2.6 }), 10);
    for (const state of states) expect(inside(state.balls[0], state.bricks[0])).toBe(false);
    const hit = states[3].balls[0];
    expect(hit.vy).toBe(-2.6);
    expect(hit.y).toBeCloseTo(94 - (88 + 3 * 2.6 - 94));
    expect(states.at(-1)!.balls[0].y).toBeLessThan(94);
  });

  it('moves a ball that starts inside an unbreakable brick out the shortest way', () => {
    const [, after] = run(board([wall('wall', 200, 100)], { x: 205, y: 109, vx: 1, vy: -1 }), 1);
    expect(after.balls[0]).toMatchObject({ x: 193, y: 108, vx: -1, vy: -1 });
  });

  it('bounces a ball up into the seam between two bricks off their faces, not the gap', () => {
    const left = brick('left', 100, 100, { durability: 3, maxDurability: 3 }), right = wall('right', 144, 100);
    const states = run(board([left, right], { x: 137.5, y: 130.8, vx: 2, vy: -2 }), 6);
    for (const state of states) for (const item of state.bricks.slice(0, 2)) expect(inside(state.balls[0], item)).toBe(false);
    const ball = states.at(-1)!.balls[0];
    expect(ball.vx).toBe(2);
    expect(ball.vy).toBe(2);
  });
});
