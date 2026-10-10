import { afterEach, describe, expect, it, vi } from 'vitest';
import { burst, reducedMotion, Sound, stepParticles } from './feedback';

afterEach(() => vi.unstubAllGlobals());

describe('game feedback', () => {
  it('creates repeatable bursts and advances particles until they expire', () => {
    const particles: Parameters<typeof burst>[0] = [];
    burst(particles, 12, 30, '#facc15', 3, 17);
    const repeated: Parameters<typeof burst>[0] = [];
    burst(repeated, 12, 30, '#facc15', 3, 17);
    expect(particles).toEqual(repeated);
    expect(particles).toHaveLength(3);
    expect(particles.every(particle => particle.x === 12 && particle.y === 30 && particle.color === '#facc15')).toBe(true);

    particles[0].life = 1;
    const before = { ...particles[1] };
    stepParticles(particles);
    expect(particles).toHaveLength(2);
    expect(particles[0]).toMatchObject({ x: before.x + before.vx, y: before.y + before.vy, vy: before.vy + 0.12, life: before.life - 1 });
  });

  it('reads the browser reduced-motion preference', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('window', { matchMedia });
    expect(reducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('wakes audio on demand and pans a hit sound toward the human player', () => {
    const output = { pan: { value: 0 }, connect: vi.fn() };
    const gain = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => output),
    };
    const oscillator = {
      type: 'sine', frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => gain), start: vi.fn(), stop: vi.fn(),
    };
    const audio = {
      state: 'suspended', currentTime: 2, destination: {}, resume: vi.fn(),
      createStereoPanner: vi.fn(() => output), createOscillator: vi.fn(() => oscillator), createGain: vi.fn(() => gain),
    };
    vi.stubGlobal('AudioContext', class { constructor() { return audio as unknown as AudioContext; } });

    const sound = new Sound();
    sound.wake();
    sound.hit(-0.8, 2);
    expect(audio.resume).toHaveBeenCalledOnce();
    expect(output.pan.value).toBe(-0.8);
    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(700, 2);
    expect(oscillator.start).toHaveBeenCalledOnce();

    sound.muted = true;
    sound.serve(0.8);
    expect(audio.createOscillator).toHaveBeenCalledOnce();
  });

  it('plays the game cues for breaks, power-ups, lives, and match results', () => {
    const frequencies: unknown[][] = [];
    const pans: number[] = [];
    const output = { pan: { value: 0 }, connect: vi.fn() };
    const gain = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => output),
    };
    const oscillator = {
      type: 'sine', frequency: {
        setValueAtTime: vi.fn((...args: unknown[]) => frequencies.push(args)),
        exponentialRampToValueAtTime: vi.fn(),
      }, connect: vi.fn(() => gain), start: vi.fn(), stop: vi.fn(),
    };
    const audio = {
      state: 'running', currentTime: 3, destination: {}, resume: vi.fn(),
      createStereoPanner: vi.fn(() => { const panner = { pan: { value: 0 }, connect: vi.fn() }; pans.push(panner.pan.value); return panner; }),
      createOscillator: vi.fn(() => oscillator), createGain: vi.fn(() => gain),
    };
    vi.stubGlobal('AudioContext', class { constructor() { return audio as unknown as AudioContext; } });

    const sound = new Sound();
    sound.wake();
    sound.paddle(-1);
    sound.break(1, 2);
    sound.powerUp(-1, true);
    sound.powerUp(1, false);
    sound.lose(-1);
    sound.count();
    sound.serve(1);
    sound.fanfare(true);
    sound.fanfare(false);
    sound.banner();

    expect(frequencies.map(([frequency]) => frequency)).toContain(1120);
    expect(frequencies.map(([frequency]) => frequency)).toContain(784);
    expect(frequencies.map(([frequency]) => frequency)).toContain(262);
    expect(frequencies.map(([, at]) => at)).toContain(3.13);
    expect(oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalled();
    expect(pans).toHaveLength(10);
  });
});
