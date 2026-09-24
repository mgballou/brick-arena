// Sound and particles. These live in the web layer only: the engine never
// knows they exist, and nothing here feeds back into a board.

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Voice = { freq: number; to?: number; type: OscillatorType; ms: number; gain: number; delay?: number };

export class Sound {
  private ctx: AudioContext | null = null;
  muted = false;

  // Browsers only start audio from a user gesture, so the first key or click wakes it.
  wake() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private play(voices: Voice[], pan = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const out = ctx.createStereoPanner();
    out.pan.value = pan;
    out.connect(ctx.destination);
    for (const voice of voices) {
      const at = ctx.currentTime + (voice.delay ?? 0) / 1000;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = voice.type;
      osc.frequency.setValueAtTime(voice.freq, at);
      if (voice.to) osc.frequency.exponentialRampToValueAtTime(voice.to, at + voice.ms / 1000);
      gain.gain.setValueAtTime(voice.gain, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + voice.ms / 1000);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + voice.ms / 1000 + 0.02);
    }
  }

  // The human's board is on the left, Jev's on the right, and each is heard there.
  paddle(pan: number) { this.play([{ freq: 220, to: 180, type: 'triangle', ms: 70, gain: 0.12 }], pan); }
  hit(pan: number, durabilityLeft: number) { this.play([{ freq: 520 + durabilityLeft * 90, type: 'square', ms: 45, gain: 0.05 }], pan); }
  break(pan: number, maxDurability: number) { this.play([{ freq: 880 + maxDurability * 120, to: 1400, type: 'square', ms: 90, gain: 0.06 }, { freq: 440, type: 'triangle', ms: 110, gain: 0.07 }], pan); }
  powerUp(pan: number, good: boolean) {
    const notes = good ? [523, 659, 784] : [392, 330, 262];
    this.play(notes.map((freq, i) => ({ freq, type: 'triangle' as const, ms: 110, gain: 0.09, delay: i * 70 })), pan);
  }
  lose(pan: number) { this.play([{ freq: 330, to: 90, type: 'sawtooth', ms: 380, gain: 0.07 }], pan); }
  serve(pan: number) { this.play([{ freq: 660, type: 'triangle', ms: 60, gain: 0.08 }], pan); }
  fanfare(win: boolean) {
    const notes = win ? [523, 659, 784, 1047] : [440, 392, 349, 262];
    this.play(notes.map((freq, i) => ({ freq, type: 'triangle' as const, ms: 220, gain: 0.1, delay: i * 130 })));
  }
  banner() { this.play([{ freq: 392, type: 'triangle', ms: 140, gain: 0.08 }, { freq: 587, type: 'triangle', ms: 200, gain: 0.08, delay: 120 }]); }
}

export type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number };

// A small seeded spray, so the same break looks the same each time.
export function burst(particles: Particle[], x: number, y: number, color: string, count: number, seed: number) {
  let n = seed >>> 0;
  const rand = () => ((n = Math.imul(1664525, n) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const speed = 0.8 + rand() * 2.4;
    const life = 22 + Math.floor(rand() * 18);
    particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1, life, max: life, color, size: 2 + rand() * 3 });
  }
}

export function stepParticles(particles: Particle[]) {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12;
    p.life--;
  }
  for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
}
