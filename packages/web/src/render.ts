import { PADDLE_H, PADDLE_Y, type BoardState, type Brick, type PowerUpKind } from '../../engine/src/index';
import type { Particle } from './feedback';

export const PALETTE = {
  bg: '#0c0e1a',
  grid: 'rgba(148, 160, 220, 0.05)',
  ink: '#f4f1e8',
  muted: '#8b90aa',
  human: '#ffb347',
  jev: '#5ee6f5',
  steel: '#3b4058',
  steelEdge: '#5c627e',
  regen: '#4ade80',
  // Brick fill by how many hits it takes when whole.
  bricks: ['#5b8def', '#a66ef0', '#f0598c'],
} as const;

export const POWER_UPS: Record<PowerUpKind, { glyph: string; color: string; label: string; good: boolean }> = {
  'extra-ball': { glyph: '+', color: '#facc15', label: 'Extra ball', good: true },
  'long-slow-paddle': { glyph: 'W', color: '#60a5fa', label: 'Wide, slow paddle', good: true },
  'piercing-ball': { glyph: 'P', color: '#fb7185', label: 'Piercing ball', good: true },
  'magnet-paddle': { glyph: 'M', color: '#c084fc', label: 'Magnet paddle', good: true },
  'short-paddle': { glyph: 'S', color: '#94a3b8', label: 'Short paddle', good: false },
};

export function brickColor(brick: Brick) {
  if (brick.unbreakable) return PALETTE.steel;
  if (brick.regenerates) return PALETTE.regen;
  return PALETTE.bricks[Math.min(brick.maxDurability, 3) - 1];
}

export type View = {
  accent: string;
  particles: Particle[];
  trail: Array<{ x: number; y: number }>;
  // 1 just after a paddle return, easing to 0.
  squash: number;
  shake: number;
  flash: number;
  motion: boolean;
  banner: string | null;
  sub: string | null;
  dim: boolean;
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

// Seeded per brick, so the cracks on a brick hold still between frames.
function cracks(ctx: CanvasRenderingContext2D, brick: Brick, count: number) {
  let n = [...brick.id].reduce((sum, ch) => sum * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rand = () => ((n = Math.imul(1664525, n) + 1013904223) >>> 0) / 4294967296;
  ctx.strokeStyle = 'rgba(8, 10, 20, 0.85)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < count; i++) {
    let x = brick.x + 6 + rand() * (brick.width - 12);
    let y = brick.y;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 3; s++) {
      x += (rand() - 0.5) * 10;
      y += brick.height / 3;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawBrick(ctx: CanvasRenderingContext2D, brick: Brick, tick: number) {
  const { x, y, width: w, height: h } = brick;
  const color = brickColor(brick);
  if (brick.unbreakable) {
    ctx.fillStyle = color;
    roundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = PALETTE.steelEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = PALETTE.steelEdge;
    for (const rx of [x + 5, x + w - 5]) {
      ctx.beginPath();
      ctx.arc(rx, y + h / 2, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  const health = brick.durability / brick.maxDurability;
  ctx.globalAlpha = 0.45 + 0.55 * health;
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, h, 3);
  ctx.fill();
  ctx.globalAlpha = 1;
  // A lit top edge gives each brick a face.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.fillRect(x + 2, y + 1, w - 4, 3);
  if (brick.durability < brick.maxDurability) cracks(ctx, brick, brick.maxDurability - brick.durability);
  // Pips show hits left on a multi-hit brick.
  if (brick.maxDurability > 1) {
    ctx.fillStyle = 'rgba(8, 10, 20, 0.7)';
    for (let i = 0; i < brick.durability; i++) {
      ctx.beginPath();
      ctx.arc(x + w / 2 + (i - (brick.durability - 1) / 2) * 7, y + h / 2 + 1, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (brick.regenerates && brick.durability < brick.maxDurability) {
    ctx.strokeStyle = `rgba(74, 222, 128, ${0.4 + 0.4 * Math.sin(tick / 6)})`;
    ctx.lineWidth = 2;
    roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 4);
    ctx.stroke();
  }
}

export function drawBoard(canvas: HTMLCanvasElement, s: BoardState, view: View) {
  const ctx = canvas.getContext('2d')!;
  const k = canvas.width / s.width;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, s.width, s.height);
  const shake = view.motion && view.shake > 0 ? view.shake : 0;
  if (shake) ctx.translate(Math.sin(view.shake * 1.7) * shake * 0.6, Math.cos(view.shake * 2.3) * shake * 0.4);

  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(-10, -10, s.width + 20, s.height + 20);
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= s.width; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s.height); ctx.stroke(); }
  for (let y = 0; y <= s.height; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s.width, y); ctx.stroke(); }

  for (const brick of s.bricks) if (brick.unbreakable || brick.durability > 0) drawBrick(ctx, brick, s.tick);

  for (const power of s.powerUps) {
    const look = POWER_UPS[power.kind];
    ctx.fillStyle = look.color;
    roundRect(ctx, power.x - 12, power.y - 7, 24, 14, 7);
    ctx.fill();
    if (!look.good) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#0c0e1a';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(look.glyph, power.x, power.y + 0.5);
  }

  // Paddle: squashes for a few frames after a return, and glows in the side's color.
  const squash = view.motion ? view.squash : 0;
  const ph = PADDLE_H * (1 - 0.35 * squash);
  const pw = s.paddleWidth + 8 * squash;
  const px = s.paddleX - 4 * squash;
  const py = PADDLE_Y + PADDLE_H - ph;
  ctx.shadowColor = view.accent;
  ctx.shadowBlur = 14;
  const grad = ctx.createLinearGradient(0, py, 0, py + ph);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.35, view.accent);
  grad.addColorStop(1, shade(view.accent));
  ctx.fillStyle = grad;
  roundRect(ctx, px, py, pw, ph, ph / 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  if (s.magnetPaddle) {
    ctx.strokeStyle = POWER_UPS['magnet-paddle'].color;
    ctx.lineWidth = 2;
    roundRect(ctx, px - 2, py - 2, pw + 4, ph + 4, ph);
    ctx.stroke();
  }

  if (view.motion) {
    view.trail.forEach((point, i) => {
      ctx.globalAlpha = (i + 1) / (view.trail.length + 1) * 0.35;
      ctx.fillStyle = view.accent;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
  for (const ball of s.balls) {
    ctx.shadowColor = ball.piercing ? POWER_UPS['piercing-ball'].color : '#ffffff';
    ctx.shadowBlur = 10;
    ctx.fillStyle = ball.piercing ? POWER_UPS['piercing-ball'].color : PALETTE.ink;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(ball.x - 2, ball.y - 2, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of view.particles) {
    ctx.globalAlpha = p.life / p.max;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  if (view.flash > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.25, view.flash / 40)})`;
    ctx.fillRect(0, 0, s.width, s.height);
  }
  if (view.dim) {
    ctx.fillStyle = 'rgba(8, 10, 20, 0.62)';
    ctx.fillRect(0, 0, s.width, s.height);
  }
  if (view.banner) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = view.accent;
    ctx.font = '800 26px "Avenir Next", "Segoe UI", system-ui, sans-serif';
    ctx.fillText(view.banner, s.width / 2, s.height / 2 + 36);
    if (view.sub) {
      ctx.fillStyle = PALETTE.ink;
      ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(view.sub, s.width / 2, s.height / 2 + 62);
    }
  }
}

function shade(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.55);
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}
