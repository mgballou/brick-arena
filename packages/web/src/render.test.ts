import { describe, expect, it } from 'vitest';
import { createBoard } from '../../engine/src/index';
import { drawBoard } from './render';

describe('board rendering', () => {
  it('shows live game objects and overlays while hiding cleared bricks', () => {
    const board = createBoard(23, 3);
    const cleared = board.bricks.find(brick => !brick.unbreakable && !brick.regenerates)!;
    cleared.durability = 0;
    const regenerating = board.bricks.find(brick => brick.regenerates)!;
    regenerating.durability = 1;
    board.powerUps = [
      { id: 'good', kind: 'extra-ball', x: 80, y: 120, vy: 1.2 },
      { id: 'bad', kind: 'short-paddle', x: 140, y: 160, vy: 1.2 },
    ];
    board.balls[0].piercing = true;
    board.balls.push({ ...board.balls[0], id: 'ball-1', x: 300, y: 220, piercing: false });

    const calls: Array<{ name: string; args: unknown[] }> = [];
    const context = new Proxy({
      createLinearGradient: (...args: unknown[]) => {
        calls.push({ name: 'createLinearGradient', args });
        return { addColorStop: (...stopArgs: unknown[]) => calls.push({ name: 'addColorStop', args: stopArgs }) };
      },
    } as Record<string, unknown>, {
      get(target, property) {
        if (property in target) return target[property as string];
        return (...args: unknown[]) => calls.push({ name: String(property), args });
      },
      set(target, property, value) {
        target[property as string] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const canvas = { width: board.width * 2, getContext: () => context } as unknown as HTMLCanvasElement;

    drawBoard(canvas, board, {
      accent: '#ffb347', particles: [{ x: 12, y: 18, vx: 0, vy: 0, life: 4, max: 4, color: '#fff', size: 3 }],
      trail: [{ x: 280, y: 240 }], squash: 0.5, shake: 2, flash: 12, motion: true,
      banner: 'LEVEL CLEAR', sub: 'Press to continue', dim: true,
    });

    const roundedBricks = calls.filter(call => call.name === 'roundRect').map(call => call.args.slice(0, 2));
    expect(roundedBricks).toContainEqual([regenerating.x - 1, regenerating.y - 1]);
    expect(roundedBricks).not.toContainEqual([cleared.x, cleared.y]);
    expect(calls.filter(call => call.name === 'fillText').map(call => call.args[0])).toEqual(['+', 'S', 'LEVEL CLEAR', 'Press to continue']);
    expect(calls.filter(call => call.name === 'arc' && call.args[2] === 6)).toHaveLength(2);
    expect(calls.some(call => call.name === 'translate')).toBe(true);
    expect(calls.some(call => call.name === 'setLineDash')).toBe(true);
  });

  it('keeps the paddle shape steady and hides the trail when motion is disabled', () => {
    const board = createBoard(1);
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const context = new Proxy({ createLinearGradient: () => ({ addColorStop: () => undefined }) }, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return (...args: unknown[]) => calls.push({ name: String(property), args });
      },
      set() { return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawBoard({ width: board.width, getContext: () => context } as unknown as HTMLCanvasElement, board, {
      accent: '#5ee6f5', particles: [], trail: [{ x: 90, y: 90 }], squash: 1, shake: 5, flash: 0,
      motion: false, banner: null, sub: null, dim: false,
    });

    expect(calls.some(call => call.name === 'translate')).toBe(false);
    expect(calls.filter(call => call.name === 'arc' && call.args[2] === 6)).toHaveLength(1);
    expect(calls.filter(call => call.name === 'roundRect').some(call => call.args[0] === board.paddleX)).toBe(true);
  });
});
