export type Decision =
  | { readonly kind: 'target'; readonly x: number }
  | { readonly kind: 'chase'; readonly powerUpId: string }
  | { readonly kind: 'track'; readonly ballId: string };
export type Brick = { id: string; x: number; y: number; width: number; height: number; durability: number; maxDurability: number; unbreakable: boolean; regenerates: boolean; lastDamagedTick: number };
export type Ball = { id: string; x: number; y: number; vx: number; vy: number; radius: number; tracked: boolean; piercing: boolean };
export type PowerUpKind = 'extra-ball' | 'long-slow-paddle' | 'piercing-ball' | 'magnet-paddle' | 'short-paddle';
export type PowerUp = { id: string; kind: PowerUpKind; x: number; y: number; vy: number };
export type BoardState = { seed: number; level: number; tick: number; width: number; height: number; paddleX: number; paddleWidth: number; paddleTargetX: number; paddleSpeed: number; magnetPaddle: boolean; bricks: Brick[]; balls: Ball[]; powerUps: PowerUp[]; completed: boolean; livesLost: number; bricksCleared: number; powerUpsTaken: number; minReturnVx?: number };
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

// Where a ball moving (dx, dy) this tick first meets a brick grown by the
// ball's radius, as a fraction of the move, and which faces it meets. The slab
// the path enters last names the face; entering both at once is a corner and
// turns both ways. A path that starts inside or only grazes an edge meets nothing.
function sweep(ball: Ball, dx: number, dy: number, brick: Brick) {
  const slab = (p: number, d: number, lo: number, hi: number) => d > 0 ? [(lo - p) / d, (hi - p) / d] : d < 0 ? [(hi - p) / d, (lo - p) / d] : p > lo && p < hi ? [-Infinity, Infinity] : [Infinity, -Infinity];
  const [xIn, xOut] = slab(ball.x, dx, brick.x - ball.radius, brick.x + brick.width + ball.radius), [yIn, yOut] = slab(ball.y, dy, brick.y - ball.radius, brick.y + brick.height + ball.radius);
  const t = Math.max(xIn, yIn);
  return t < 0 || t > 1 || t >= Math.min(xOut, yOut) ? null : { t, x: xIn >= yIn, y: yIn >= xIn };
}

// A ball that starts a tick inside a brick leaves by the shortest way out and
// turns on that axis if it was heading further in.
function pushOut(ball: Ball, brick: Brick) {
  const exits = [
    { axis: 'x', to: brick.x - ball.radius, depth: ball.x + ball.radius - brick.x, inward: ball.vx > 0 },
    { axis: 'x', to: brick.x + brick.width + ball.radius, depth: brick.x + brick.width - (ball.x - ball.radius), inward: ball.vx < 0 },
    { axis: 'y', to: brick.y - ball.radius, depth: ball.y + ball.radius - brick.y, inward: ball.vy > 0 },
    { axis: 'y', to: brick.y + brick.height + ball.radius, depth: brick.y + brick.height - (ball.y - ball.radius), inward: ball.vy < 0 },
  ] as const;
  if (exits.some(exit => exit.depth <= 0)) return;
  const exit = exits.reduce((best, item) => item.depth < best.depth ? item : best);
  if (exit.axis === 'x') { ball.x = exit.to; if (exit.inward) ball.vx *= -1; } else { ball.y = exit.to; if (exit.inward) ball.vy *= -1; }
}

// Moves a ball one tick through the bricks: to the nearest face on its path,
// off it, and on with the rest of the move, so no speed carries it through a
// brick. A piercing ball passes breakable bricks, damaging each it overlaps,
// but not unbreakable ones. A ball wedged past eight bounces stops where it is.
function moveThroughBricks(ball: Ball, bricks: Brick[], dt: number, damage: (brick: Brick) => void) {
  const blocks = (brick: Brick) => brick.unbreakable || (brick.durability > 0 && !ball.piercing);
  for (const brick of bricks) if (blocks(brick)) pushOut(ball, brick);
  let dx = ball.vx * dt, dy = ball.vy * dt;
  for (let bounces = 0; bounces < 8; bounces++) {
    let hit: { brick: Brick; t: number; x: boolean; y: boolean } | null = null;
    for (const brick of bricks) { if (!blocks(brick)) continue; const found = sweep(ball, dx, dy, brick); if (found && (!hit || found.t < hit.t)) hit = { brick, ...found }; }
    if (!hit) { ball.x += dx; ball.y += dy; break; }
    ball.x += dx * hit.t; ball.y += dy * hit.t; dx *= 1 - hit.t; dy *= 1 - hit.t;
    if (hit.x) { ball.x = dx > 0 ? hit.brick.x - ball.radius : hit.brick.x + hit.brick.width + ball.radius; dx *= -1; ball.vx *= -1; }
    if (hit.y) { ball.y = dy > 0 ? hit.brick.y - ball.radius : hit.brick.y + hit.brick.height + ball.radius; dy *= -1; ball.vy *= -1; }
    damage(hit.brick);
  }
  if (ball.piercing) for (const brick of bricks) if (!brick.unbreakable && brick.durability > 0 && intersects(ball, brick)) damage(brick);
}

export function step(state: BoardState, dt = 1): BoardState {
  if (state.completed) return state;
  const next = structuredClone(state); next.tick += dt; next.paddleX += clamp(next.paddleTargetX - (next.paddleX + next.paddleWidth / 2), -next.paddleSpeed * dt, next.paddleSpeed * dt); const random = rng(next.seed + next.tick + next.level * 997);
  for (const brick of next.bricks) if (brick.regenerates && brick.durability > 0 && brick.durability < brick.maxDurability && next.tick - brick.lastDamagedTick >= 90) brick.durability++;
  const damage = (brick: Brick) => { if (brick.unbreakable) return; brick.durability--; brick.lastDamagedTick = next.tick; if (brick.durability === 0) { next.bricksCleared++; if (random() < 0.18) { const kinds = powerUpKinds[next.level % powerUpKinds.length]; next.powerUps.push({ id: `power-${next.tick}-${brick.id}`, kind: kinds[next.bricksCleared % kinds.length], x: brick.x + brick.width / 2, y: brick.y, vy: 1.2 }); } } };
  for (const ball of next.balls) {
    moveThroughBricks(ball, next.bricks, dt, damage);
    if (ball.x - ball.radius < 0 || ball.x + ball.radius > W) { ball.x = clamp(ball.x, ball.radius, W - ball.radius); ball.vx *= -1; }
    if (ball.y - ball.radius < 0) { ball.y = ball.radius; ball.vy = Math.abs(ball.vy); }
    const paddle = { x: next.paddleX, y: PADDLE_Y, width: next.paddleWidth, height: 10 };
    if (ball.vy > 0 && intersects(ball, paddle)) { ball.y = PADDLE_Y - ball.radius; ball.vy = -Math.abs(ball.vy); ball.vx = clamp((ball.x - (paddle.x + paddle.width / 2)) / 12, -3.8, 3.8); if (next.magnetPaddle) ball.vx *= 0.45; }
    if (ball.y > H + 20) { next.livesLost++; ball.x = W / 2; ball.y = PADDLE_Y - 30; ball.vy = -2.6; }
  }
  for (const power of next.powerUps) { power.y += power.vy * dt; const paddle = { x: next.paddleX, y: PADDLE_Y, width: next.paddleWidth, height: 10 }; if (intersects({ ...next.balls[0], x: power.x, y: power.y, radius: 5 }, paddle)) { next.powerUpsTaken++; if (power.kind === 'long-slow-paddle') { next.paddleWidth = Math.min(130, next.paddleWidth + 24); next.paddleSpeed = 3; } if (power.kind === 'short-paddle') next.paddleWidth = Math.max(70, next.paddleWidth - 36); if (power.kind === 'magnet-paddle') next.magnetPaddle = true; if (power.kind === 'piercing-ball') for (const item of next.balls) item.piercing = true; if (power.kind === 'extra-ball') next.balls.push({ id: `ball-${next.balls.length}`, x: power.x, y: power.y, vx: 2.4, vy: -2.4, radius: BALL_R, tracked: false, piercing: false }); power.y = H + 100; } }
  next.powerUps = next.powerUps.filter(power => power.y < H + 20); next.completed = next.bricks.every(brick => brick.unbreakable || brick.durability === 0); return next;
}

// The paddle sends a ball back at (hit point - paddle center) / 12 px a tick
// sideways, no faster than 3.8 (see `step`), so where the paddle stands under
// the landing point picks where the ball goes next. The reach keeps the hit
// point this far inside the paddle's edge, so an aimed catch is still a catch.
const RETURN_SLOPE = 12, MAX_RETURN_VX = 3.8, AIM_EDGE = 10;
const magnetDamping = (state: BoardState) => state.magnetPaddle ? 0.45 : 1;
const paddleReach = (state: BoardState) => Math.min(state.paddleWidth / 2 - AIM_EDGE, RETURN_SLOPE * MAX_RETURN_VX);

// The x at which the paddle's center sends the ball off at `vx`, given where
// it lands. A magnet paddle damps the return, so it stands further off.
function paddleForReturn(state: BoardState, landing: number, vx: number) {
  const reach = paddleReach(state);
  return landing - clamp(RETURN_SLOPE * vx / magnetDamping(state), -reach, reach);
}

// Each column's hit points a ball can reach from below: counting up from its
// lowest live brick until an unbreakable one blocks the way. Keyed by the
// column's center x.
export function openHitPoints(state: BoardState): Map<number, number> {
  const columns = new Map<number, Brick[]>();
  for (const brick of state.bricks) {
    if (!brick.unbreakable && brick.durability === 0) continue;
    const x = brick.x + brick.width / 2;
    columns.set(x, [...(columns.get(x) ?? []), brick]);
  }
  const open = new Map<number, number>();
  for (const [x, bricks] of columns) {
    let hitPoints = 0;
    for (const brick of [...bricks].sort((a, b) => b.y - a.y)) { if (brick.unbreakable) break; hitPoints += brick.durability; }
    open.set(x, hitPoints);
  }
  return open;
}

// The first brick a ball sent up from `landing` at `vx` meets, cast leg by leg
// between the side walls with the same sweep `step` moves it by; null if it
// reaches the top untouched.
function firstBrick(state: BoardState, ball: Ball, landing: number, vx: number): Brick | null {
  const blocking = state.bricks.filter(brick => brick.unbreakable || brick.durability > 0);
  const r = ball.radius, vy = -Math.abs(ball.vy);
  let x = landing, y = PADDLE_Y - r, dx = vx;
  for (let leg = 0; leg < 8; leg++) {
    const toTop = (y - r) / -vy;
    const toWall = dx > 0 ? (state.width - r - x) / dx : dx < 0 ? (r - x) / dx : Infinity;
    const t = Math.min(toTop, toWall);
    const probe: Ball = { ...ball, x, y };
    let met: { brick: Brick; t: number } | null = null;
    for (const brick of blocking) { const found = sweep(probe, dx * t, vy * t, brick); if (found && (!met || found.t < met.t)) met = { brick, t: found.t }; }
    if (met) return met.brick;
    if (toTop <= toWall) return null;
    x += dx * t; y += vy * t; dx = -dx;
  }
  return null;
}

// The return that sends the ball into the most open hit points it can reach
// from this catch: every sideways speed the paddle can give, in steps of 0.1,
// flown to the first brick it meets. A board may floor the return's speed
// (`minReturnVx`, as the arena does), and a return under it is not offered.
// Ties go to the steeper return. Null when no return reaches a breakable brick.
export function aimShot(state: BoardState, ball: Ball, landing: number): { paddleX: number; x: number; hitPoints: number } | null {
  const open = openHitPoints(state);
  const fastest = (paddleReach(state) / RETURN_SLOPE) * magnetDamping(state);
  const slowest = state.minReturnVx ?? 0;
  let best: { vx: number; x: number; hitPoints: number } | null = null;
  for (let tenths = -Math.floor(fastest * 10); tenths <= fastest * 10; tenths++) {
    const vx = tenths / 10;
    if (Math.abs(vx) < slowest) continue;
    const brick = firstBrick(state, ball, landing, vx);
    if (!brick || brick.unbreakable) continue;
    const x = brick.x + brick.width / 2, hitPoints = open.get(x) ?? 0;
    if (!best || hitPoints > best.hitPoints || (hitPoints === best.hitPoints && Math.abs(vx) < Math.abs(best.vx))) best = { vx, x, hitPoints };
  }
  return best && { paddleX: paddleForReturn(state, landing, best.vx), x: best.x, hitPoints: best.hitPoints };
}

// The target question's four places for the paddle, in the order `targetKeys`
// names them in packages/jev/src/wire.ts: under the landing point, aimed at the
// densest bricks the ball can reach (under the landing point if none), and off
// the landing point so the ball leaves at 45 degrees to the left or right.
export function targetOptions(state: BoardState, ball: Ball): number[] {
  const landing = predictPaddleX(ball);
  const diagonal = Math.abs(ball.vy);
  return [landing, aimShot(state, ball, landing)?.paddleX ?? landing, paddleForReturn(state, landing, -diagonal), paddleForReturn(state, landing, diagonal)];
}

export function askForDecision(state: BoardState): Ask { const visible = state.powerUps.filter(power => power.y < state.height && power.y > 0); if (visible.length) return { state, at: state.tick, question: 'chase', options: [...visible.map(power => power.id), 'none'] }; if (state.balls.length > 1) return { state, at: state.tick, question: 'track', options: state.balls.map(ball => ball.id) }; const ball = state.balls.find(item => item.tracked) ?? state.balls[0]; return { state, at: state.tick, question: 'target', options: targetOptions(state, ball) }; }
export function botPlayer(): Player { return { name: 'Deterministic bot', decide: async ask => { const start = performance.now(); if (ask.question === 'chase') { const choice = ask.options.find(option => typeof option === 'string' && option !== 'none'); return { decision: { kind: 'chase', powerUpId: String(choice ?? 'none') }, ms: Math.round(performance.now() - start) }; } if (ask.question === 'track') return { decision: { kind: 'track', ballId: String(ask.options[0]) }, ms: Math.round(performance.now() - start) }; const ball = ask.state.balls.find(item => item.tracked) ?? ask.state.balls[0]; return { decision: { kind: 'target', x: predictPaddleX(ball) }, ms: Math.round(performance.now() - start) }; } }; }
export function humanPlayer(target?: number): Player { return { name: 'Human', decide: async ask => ({ decision: ask.question === 'target' ? { kind: 'target', x: target ?? Number(ask.options[0]) } : ask.question === 'chase' ? { kind: 'chase', powerUpId: String(ask.options.at(-1)) } : { kind: 'track', ballId: String(ask.options[0]) }, ms: 180 }) }; }
export function applyDecision(state: BoardState, decision: Decision): BoardState { const next = structuredClone(state); if (decision.kind === 'target') next.paddleTargetX = clamp(decision.x, next.paddleWidth / 2, next.width - next.paddleWidth / 2); if (decision.kind === 'chase') { const power = next.powerUps.find(item => item.id === decision.powerUpId); if (power) next.paddleTargetX = clamp(power.x, next.paddleWidth / 2, next.width - next.paddleWidth / 2); } if (decision.kind === 'track') for (const ball of next.balls) ball.tracked = ball.id === decision.ballId; return next; }
