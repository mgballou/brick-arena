import { describe, expect, it } from 'vitest';
import { ARENA, arenaBoard, arenaStep, boardAhead, bounced, clearBonus, holdServe, launch, levelOver, levelScore, levelWinner, livesLeft, percentCleared, POINTS, sideStatus } from './arena';
import { aimShot, applyDecision, askForDecision, createBoard, openHitPoints, PADDLE_Y, type BoardState } from './index';

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
  it('reads a brick hit and a break, and scores each hit point broken as a share of the level', () => {
    const board = arenaBoard(1, 0);
    const total = board.bricks.reduce((n, item) => n + item.maxDurability, 0);
    const brick = board.bricks.find(item => item.maxDurability === 2)!;
    board.balls[0] = { ...board.balls[0], x: brick.x + 20, y: brick.y + brick.height + 7, vx: 0, vy: -2 };
    const first = arenaStep(board);
    expect(first.events.hits).toEqual([{ x: brick.x + 20, y: brick.y + 9, broke: false, maxDurability: 2 }]);
    expect(percentCleared(first.state)).toBe(Math.floor(100 / total));

    first.state.balls[0] = { ...first.state.balls[0], x: brick.x + 20, y: brick.y + brick.height + 7, vx: 0, vy: -2 };
    const second = arenaStep(first.state);
    expect(second.events.hits[0].broke).toBe(true);
    expect(levelScore(second.state, null)).toBe(POINTS.percentCleared * Math.floor(200 / total));
  });

  it('scores nothing for a lost ball, which costs only the serve, and ends the level on the last', () => {
    let board = arenaBoard(1, 0);
    board.bricks[0].durability = 0;
    const before = levelScore(board, null);
    for (let ball = 1; ball <= ARENA.lives; ball++) {
      board.balls[0] = { ...board.balls[0], y: board.height + 19, vy: 3 };
      const { state, events } = arenaStep(board);
      expect(events.lifeLost).toBe(true);
      expect(levelScore(state, null)).toBe(before);
      expect(sideStatus(state)).toBe(ball < ARENA.lives ? 'playing' : 'out');
      board = holdServe(state);
    }
    expect(ARENA.serveTicks).toBe(45);
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

  // A board of `level` with every breakable hit point broken but `left`.
  const leaving = (level: number, left: number): BoardState => {
    const board = arenaBoard(3, level);
    let keep = left;
    for (const brick of board.bricks) if (!brick.unbreakable) { brick.durability = Math.min(keep, brick.maxDurability); keep -= brick.durability; }
    board.completed = left === 0;
    return board;
  };

  it('scores the first clear above any board not cleared, however late the clear', () => {
    const lastFrame = ARENA.levelSeconds * ARENA.ticksPerSecond;
    for (let level = 0; level < ARENA.levels; level++) {
      const cleared = side('cleared', lastFrame, levelScore(leaving(level, 0), lastFrame));
      const almost = side('playing', null, levelScore(leaving(level, 1), null));
      expect(percentCleared(leaving(level, 1))).toBeLessThan(100);
      expect(cleared.levelScore).toBeGreaterThan(almost.levelScore);
      expect(levelWinner(cleared, almost)).toBe('human');
      expect(levelWinner(almost, cleared)).toBe('jev');
    }
  });

  it('gives the level to the higher score: the clear, else the larger share cleared', () => {
    expect(levelWinner(side('out', null, 300), side('out', null, 200))).toBe('human');
    expect(levelWinner(side('out', null, 100), side('playing', null, 200))).toBe('jev');
    expect(levelWinner(side('out', null, 100), side('out', null, 100))).toBe('tie');
    expect(levelWinner(side('cleared', 600, 1800), side('cleared', 600, 1800))).toBe('tie');
  });

  it('pays for time left on a clear, by the frame of the clear', () => {
    expect(clearBonus(12.7)).toBe(12 * POINTS.secondLeft);
    expect(levelScore(leaving(0, 0), 30 * ARENA.ticksPerSecond)).toBe(100 * POINTS.percentCleared + (ARENA.levelSeconds - 30) * POINTS.secondLeft);
    expect(sideStatus({ ...arenaBoard(1, 0), livesLost: ARENA.lives })).toBe('out');
  });

  it('counts a regenerated hit point as unbroken again', () => {
    const board = arenaBoard(1, 3);
    const brick = board.bricks.find(item => item.regenerates)!;
    brick.durability = 1;
    brick.lastDamagedTick = 0;
    board.tick = 89;
    const damaged = percentCleared(board);
    expect(percentCleared(arenaStep(board).state)).toBeLessThan(damaged);
  });
});

describe('asking ahead', () => {
  it('is the board a run of arena steps from now, and leaves the board on screen alone', () => {
    const board = launch(arenaBoard(7, 0));
    let stepped = board;
    for (let i = 0; i < 44; i++) stepped = arenaStep(stepped).state;
    const copy = structuredClone(board);
    expect(boardAhead(board, 44)).toEqual(stepped);
    expect(board).toEqual(copy);
    expect(boardAhead(board, 0)).toBe(board);
  });

  it('stops short of a lost life', () => {
    const board = arenaBoard(7, 0);
    board.balls[0] = { ...board.balls[0], x: 20, y: PADDLE_Y + 20, vx: 0, vy: 3 };
    const ahead = boardAhead(board, 60);
    expect(ahead.livesLost).toBe(0);
    expect(arenaStep(ahead).events.lifeLost).toBe(true);
  });

  it('names a turned ball as a bounce', () => {
    const board = launch(arenaBoard(7, 0));
    const falling = structuredClone(board);
    falling.balls[0].vy = 2.6;
    expect(bounced(board, falling)).toBe(true);
    expect(bounced(board, arenaStep(board).state)).toBe(false);
  });
});

describe('aiming at the densest bricks', () => {
  it('counts each column\'s hit points open from below, stopping at an unbreakable brick', () => {
    const board = arenaBoard(1, 0);
    for (const brick of board.bricks) if (brick.id.startsWith('brick-7-')) brick.durability = 3;
    expect(openHitPoints(board).get(18 + 7 * 44 + 20)).toBe(6);
    expect(openHitPoints(board).get(18 + 20)).toBe(3);

    // Split walls: column 3 is a 1 over a 1 over a wall.
    expect(openHitPoints(arenaBoard(1, 1)).get(18 + 3 * 44 + 20)).toBe(0);
  });

  it('sends a caught ball into that column', () => {
    let board = arenaBoard(1, 0);
    for (const brick of board.bricks) if (brick.id.startsWith('brick-7-')) brick.durability = 3;
    board.balls[0] = { ...board.balls[0], x: 100, y: 250, vx: 0, vy: 2.6 };
    const ask = askForDecision(board);
    const aim = Number(ask.options[1]);
    expect(ask.options[0]).toBe(100);
    board = applyDecision(board, { kind: 'target', x: aim });
    board.paddleX = aim - board.paddleWidth / 2;
    for (let i = 0; i < 400; i++) {
      const { state, events } = arenaStep(board);
      board = state;
      if (events.hits.length) { expect(events.hits[0].x).toBe(18 + 7 * 44 + 20); return; }
    }
    throw new Error('the ball hit no brick');
  });

  it('never aims a return the arena would steepen, so a column overhead is sought at an angle', () => {
    const board = arenaBoard(1, 0);
    for (const brick of board.bricks) if (brick.id.startsWith('brick-2-')) brick.durability = 3;
    const ball = { ...board.balls[0], x: 106, y: 250, vx: 0, vy: 2.6 };
    const shot = aimShot(board, ball, 106)!;
    expect(Math.abs(106 - shot.paddleX) / 12).toBeGreaterThanOrEqual(ARENA.minReturnVx);
    expect(aimShot(createBoard(1, 0), ball, 106)).not.toBeNull();
  });

  it('offers a 45 degree return each way', () => {
    const board = arenaBoard(1, 0);
    board.balls[0] = { ...board.balls[0], x: 240, y: 250, vx: 0, vy: 2.6 };
    const [landing, , left, right] = askForDecision(board).options.map(Number);
    expect((landing - left) / 12).toBeCloseTo(-2.6);
    expect((landing - right) / 12).toBeCloseTo(2.6);
  });
});
