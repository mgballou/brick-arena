export type Decision =
  | { readonly kind: 'target'; readonly x: number }
  | { readonly kind: 'chase'; readonly powerUpId: string }
  | { readonly kind: 'track'; readonly ballId: string };
export type Brick = { id: string; x: number; y: number; width: number; height: number; durability: number; maxDurability: number; unbreakable: boolean; regenerates: boolean; lastDamagedTick: number };
export type Ball = { id: string; x: number; y: number; vx: number; vy: number; radius: number; tracked: boolean; piercing: boolean };
export type PowerUpKind = 'extra-ball' | 'long-slow-paddle' | 'piercing-ball' | 'magnet-paddle' | 'short-paddle';
export type PowerUp = { id: string; kind: PowerUpKind; x: number; y: number; vy: number };
export type BoardState = { seed: number; level: number; tick: number; width: number; height: number; paddleX: number; paddleWidth: number; paddleTargetX: number; paddleSpeed: number; magnetPaddle: boolean; bricks: Brick[]; balls: Ball[]; powerUps: PowerUp[]; completed: boolean; livesLost: number; bricksCleared: number; powerUpsTaken: number };
export type Ask = { state: BoardState; at: number; question: 'target' | 'chase' | 'track'; options: ReadonlyArray<string | number> };
export type Player = { readonly name: string; readonly decide: (ask: Ask) => Promise<{ decision: Decision; ms: number }> };
export type DecisionRecord = { seed: number; tick: number; ask: Ask; question: Ask['question']; options: Ask['options']; decision: Decision; ms: number; outcome: string };

const W = 480, H = 320, BALL_R = 6;
export const PADDLE_Y = 294, PADDLE_H = 10;
const levelPatterns = [
  ['1111111111', '1222222221', '1000000001'],
  ['11#11#11#1', '11#11#11#1', '111#11#111', '000#00#000'],
  ['###1#1####', '###2#2####', '###2#2####', '###1#1####'],
  ['rrrrrrrrrr', 'r22222222r', 'r20000002r', 'r11111111r'],
  ['3333333333', '3111111113', '31#2222#13', '31#2222#13'],
] as const;
export const levelNames = ['multi-hit rows', 'split walls', 'narrow gap', 'regenerating perimeter', 'power-up hazards'] as const;
const powerUpKinds: PowerUpKind[][] = [['extra-ball', 'long-slow-paddle'], ['extra-ball', 'short-paddle'], ['piercing-ball', 'magnet-paddle'], ['long-slow-paddle', 'short-paddle'], ['extra-ball', 'short-paddle', 'piercing-ball']];
const rng = (seed: number) => { let n = seed >>> 0; return () => ((n = Math.imul(1664525, n) + 1013904223) >>> 0) / 4294967296; };

export function createBoard(seed: number, level = 0): BoardState {
  const bricks: Brick[] = [], pattern = levelPatterns[level % levelPatterns.length];
  pattern.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === '0') return; const unbreakable = cell === '#', regenerates = cell === 'r', durability = unbreakable ? 1 : regenerates ? 2 : Number(cell); bricks.push({ id: `brick-${x}-${y}`, x: 18 + x * 44, y: 28 + y * 23, width: 40, height: 18, durability, maxDurability: durability, unbreakable, regenerates, lastDamagedTick: 0 }); }));
  return { seed, level, tick: 0, width: W, height: H, paddleX: W / 2 - 90, paddleWidth: 180, paddleTargetX: W / 2, paddleSpeed: 5, magnetPaddle: false, bricks, balls: [{ id: 'ball-0', x: W / 2, y: PADDLE_Y - 30, vx: 2.2, vy: -2.6, radius: BALL_R, tracked: true, piercing: false }], powerUps: [], completed: false, livesLost: 0, bricksCleared: 0, powerUpsTaken: 0 };
}
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export function predictPaddleX(ball: Ball, width = W, paddleY = PADDLE_Y) { if (ball.vy <= 0) return width / 2; const t = (paddleY - ball.y) / ball.vy, raw = ball.x + ball.vx * t, period = 2 * width, folded = ((raw % period) + period) % period; return folded <= width ? folded : period - folded; }
function intersects(ball: { x: number; y: number; radius: number }, rect: { x: number; y: number; width: number; height: number }) { return ball.x + ball.radius >= rect.x && ball.x - ball.radius <= rect.x + rect.width && ball.y + ball.radius >= rect.y && ball.y - ball.radius <= rect.y + rect.height; }

export function step(state: BoardState, dt = 1): BoardState {
  if (state.completed) return state;
  const next = structuredClone(state); next.tick += dt; next.paddleX += clamp(next.paddleTargetX - (next.paddleX + next.paddleWidth / 2), -next.paddleSpeed * dt, next.paddleSpeed * dt); const random = rng(next.seed + next.tick + next.level * 997);
  for (const brick of next.bricks) if (brick.regenerates && brick.durability > 0 && brick.durability < brick.maxDurability && next.tick - brick.lastDamagedTick >= 90) brick.durability++;
  for (const ball of next.balls) {
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    if (ball.x - ball.radius < 0 || ball.x + ball.radius > W) { ball.x = clamp(ball.x, ball.radius, W - ball.radius); ball.vx *= -1; }
    if (ball.y - ball.radius < 0) { ball.y = ball.radius; ball.vy = Math.abs(ball.vy); }
    const paddle = { x: next.paddleX, y: PADDLE_Y, width: next.paddleWidth, height: 10 };
    if (ball.vy > 0 && intersects(ball, paddle)) { ball.y = PADDLE_Y - ball.radius; ball.vy = -Math.abs(ball.vy); ball.vx = clamp((ball.x - (paddle.x + paddle.width / 2)) / 12, -3.8, 3.8); if (next.magnetPaddle) ball.vx *= 0.45; }
    for (const brick of next.bricks) if (intersects(ball, brick) && (brick.unbreakable || brick.durability > 0)) { if (!ball.piercing) ball.vy *= -1; if (!brick.unbreakable) { brick.durability--; brick.lastDamagedTick = next.tick; if (brick.durability === 0) { next.bricksCleared++; if (random() < 0.18) { const kinds = powerUpKinds[next.level % powerUpKinds.length]; next.powerUps.push({ id: `power-${next.tick}-${brick.id}`, kind: kinds[next.bricksCleared % kinds.length], x: brick.x + brick.width / 2, y: brick.y, vy: 1.2 }); } } } break; }
    if (ball.y > H + 20) { next.livesLost++; ball.x = W / 2; ball.y = PADDLE_Y - 30; ball.vy = -2.6; }
  }
  for (const power of next.powerUps) { power.y += power.vy * dt; const paddle = { x: next.paddleX, y: PADDLE_Y, width: next.paddleWidth, height: 10 }; if (intersects({ ...next.balls[0], x: power.x, y: power.y, radius: 5 }, paddle)) { next.powerUpsTaken++; if (power.kind === 'long-slow-paddle') { next.paddleWidth = Math.min(130, next.paddleWidth + 24); next.paddleSpeed = 3; } if (power.kind === 'short-paddle') next.paddleWidth = Math.max(70, next.paddleWidth - 36); if (power.kind === 'magnet-paddle') next.magnetPaddle = true; if (power.kind === 'piercing-ball') for (const item of next.balls) item.piercing = true; if (power.kind === 'extra-ball') next.balls.push({ id: `ball-${next.balls.length}`, x: power.x, y: power.y, vx: 2.4, vy: -2.4, radius: BALL_R, tracked: false, piercing: false }); power.y = H + 100; } }
  next.powerUps = next.powerUps.filter(power => power.y < H + 20); next.completed = next.bricks.every(brick => brick.unbreakable || brick.durability === 0); return next;
}

export function askForDecision(state: BoardState): Ask { const visible = state.powerUps.filter(power => power.y < state.height && power.y > 0); if (visible.length) return { state, at: state.tick, question: 'chase', options: [...visible.map(power => power.id), 'none'] }; if (state.balls.length > 1) return { state, at: state.tick, question: 'track', options: state.balls.map(ball => ball.id) }; const ball = state.balls.find(item => item.tracked) ?? state.balls[0]; return { state, at: state.tick, question: 'target', options: [predictPaddleX(ball), state.width / 2, 80, state.width - 80] }; }
export function botPlayer(): Player { return { name: 'Deterministic bot', decide: async ask => { const start = performance.now(); if (ask.question === 'chase') { const choice = ask.options.find(option => typeof option === 'string' && option !== 'none'); return { decision: { kind: 'chase', powerUpId: String(choice ?? 'none') }, ms: Math.round(performance.now() - start) }; } if (ask.question === 'track') return { decision: { kind: 'track', ballId: String(ask.options[0]) }, ms: Math.round(performance.now() - start) }; const ball = ask.state.balls.find(item => item.tracked) ?? ask.state.balls[0]; return { decision: { kind: 'target', x: predictPaddleX(ball) }, ms: Math.round(performance.now() - start) }; } }; }
export function humanPlayer(target?: number): Player { return { name: 'Human', decide: async ask => ({ decision: ask.question === 'target' ? { kind: 'target', x: target ?? Number(ask.options[0]) } : ask.question === 'chase' ? { kind: 'chase', powerUpId: String(ask.options.at(-1)) } : { kind: 'track', ballId: String(ask.options[0]) }, ms: 180 }) }; }
export function applyDecision(state: BoardState, decision: Decision): BoardState { const next = structuredClone(state); if (decision.kind === 'target') next.paddleTargetX = clamp(decision.x, next.paddleWidth / 2, next.width - next.paddleWidth / 2); if (decision.kind === 'chase') { const power = next.powerUps.find(item => item.id === decision.powerUpId); if (power) next.paddleTargetX = clamp(power.x, next.paddleWidth / 2, next.width - next.paddleWidth / 2); } if (decision.kind === 'track') for (const ball of next.balls) ball.tracked = ball.id === decision.ballId; return next; }
