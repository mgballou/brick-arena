import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyDecision, askForDecision, levelNames, type BoardState } from '../../engine/src/index';
import {
  ARENA, arenaBoard, arenaStep, boardAhead, bounced, clearBonus, holdServe, launch, levelOver, levelWinner, livesLeft, sideStatus,
  type ArenaEvents, type LevelSide, type SideStatus,
} from '../../engine/src/arena';
import { burst, reducedMotion, Sound, stepParticles } from './feedback';
import { askJev, probeJev, type Probe } from './jev';
import { brickColor, drawBoard, PALETTE, POWER_UPS, type View } from './render';
import './style.css';

const SEED = 20260919;
const TICK_MS = 1000 / ARENA.ticksPerSecond;
const JEV_SERVE_TICKS = 45;
const OFFLINE_AFTER = 2;

type Phase = 'title' | 'banner' | 'playing' | 'paused' | 'offline' | 'levelEnd' | 'final';
type Who = 'human' | 'jev';

type Side = {
  who: Who;
  state: BoardState;
  serving: boolean;
  serveWait: number;
  score: number;
  levelScore: number;
  clearedAt: number | null;
  view: View;
};

type JevStats = { calls: number; answered: number; timeouts: number; errors: number; offlineStreak: number; lastChoice: string; lastMs: number | null; ms: number[]; pending: boolean };
type LevelResult = { level: number; winner: 'human' | 'jev' | 'tie'; human: number; jev: number; humanCleared: boolean; jevCleared: boolean };

type Match = { level: number; frame: number; gen: number; human: Side; jev: Side; stats: JevStats; results: LevelResult[]; offlineReason: string };

const blankStats = (): JevStats => ({ calls: 0, answered: 0, timeouts: 0, errors: 0, offlineStreak: 0, lastChoice: '', lastMs: null, ms: [], pending: false });

function newSide(who: Who, level: number, score = 0): Side {
  return {
    who,
    state: arenaBoard(SEED, level),
    serving: true,
    serveWait: 0,
    score,
    levelScore: 0,
    clearedAt: null,
    view: { accent: who === 'human' ? PALETTE.human : PALETTE.jev, particles: [], trail: [], squash: 0, shake: 0, flash: 0, motion: true, banner: null, sub: null, dim: false },
  };
}

function newMatch(): Match {
  return { level: 0, frame: 0, gen: 0, human: newSide('human', 0), jev: newSide('jev', 0), stats: blankStats(), results: [], offlineReason: '' };
}

const levelSide = (side: Side): LevelSide => ({ status: sideStatus(side.state), clearedAt: side.clearedAt, levelScore: side.levelScore });
const secondsLeft = (match: Match) => ARENA.levelSeconds - match.frame / ARENA.ticksPerSecond;
const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const clock = (seconds: number) => { const s = Math.max(0, Math.ceil(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const title = (name: string) => name[0].toUpperCase() + name.slice(1);

type SideHud = { score: number; levelScore: number; lives: number; status: SideStatus; serving: boolean };
type Hud = { level: number; seconds: number; human: SideHud; jev: SideHud; stats: JevStats };

function snapshot(match: Match): Hud {
  const side = (s: Side): SideHud => ({ score: s.score, levelScore: s.levelScore, lives: livesLeft(s.state), status: sideStatus(s.state), serving: s.serving });
  return { level: match.level, seconds: secondsLeft(match), human: side(match.human), jev: side(match.jev), stats: { ...match.stats, ms: match.stats.ms } };
}

function App() {
  const game = useRef<Match>(newMatch());
  const phaseRef = useRef<Phase>('title');
  const keys = useRef({ left: false, right: false, launch: false });
  const sound = useRef(new Sound());
  const humanCanvas = useRef<HTMLCanvasElement>(null);
  const jevCanvas = useRef<HTMLCanvasElement>(null);

  const [phase, setPhaseState] = useState<Phase>('title');
  const [probe, setProbe] = useState<Probe | 'checking'>('checking');
  const probeMs = useRef(0);
  const [hud, setHud] = useState<Hud>(() => snapshot(game.current));
  const [muted, setMuted] = useState(false);

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const checkJev = useCallback(async () => {
    setProbe('checking');
    const result = await probeJev();
    if (result.ok) probeMs.current = result.ms;
    setProbe(result);
    return result;
  }, []);

  useEffect(() => { void checkJev(); }, [checkJev]);

  const startLevel = useCallback((level: number) => {
    const match = game.current;
    match.level = level;
    match.frame = 0;
    match.gen++;
    match.stats.pending = false;
    match.human = newSide('human', level, match.human.score);
    match.jev = newSide('jev', level, match.jev.score);
    keys.current.launch = false;
    setHud(snapshot(match));
    setPhase('banner');
    sound.current.banner();
  }, [setPhase]);

  const startGame = useCallback(() => {
    sound.current.wake();
    game.current = newMatch();
    startLevel(0);
  }, [startLevel]);

  const endLevel = useCallback(() => {
    const match = game.current;
    const human = levelSide(match.human), jev = levelSide(match.jev);
    const winner = levelWinner(human, jev);
    match.results.push({ level: match.level, winner, human: match.human.levelScore, jev: match.jev.levelScore, humanCleared: human.clearedAt !== null, jevCleared: jev.clearedAt !== null });
    match.gen++;
    setHud(snapshot(match));
    setPhase('levelEnd');
    sound.current.fanfare(winner !== 'jev');
  }, [setPhase]);

  const advance = useCallback(() => {
    const match = game.current;
    if (match.level + 1 < ARENA.levels) startLevel(match.level + 1);
    else {
      setPhase('final');
      sound.current.fanfare(match.human.score >= match.jev.score);
    }
  }, [setPhase, startLevel]);

  const retryJev = useCallback(async () => {
    const result = await checkJev();
    if (result.ok) {
      game.current.stats.offlineStreak = 0;
      setPhase('playing');
    }
  }, [checkJev, setPhase]);

  // What a scored step means on screen and in the speakers.
  const feel = useCallback((side: Side, before: BoardState, events: ArenaEvents) => {
    const pan = side.who === 'human' ? -0.6 : 0.6;
    const motion = side.view.motion;
    side.score += events.points;
    side.levelScore += events.points;
    for (const hit of events.hits) {
      const brick = before.bricks.find(item => item.x + item.width / 2 === hit.x && item.y + item.height / 2 === hit.y);
      const color = brick ? brickColor(brick) : PALETTE.ink;
      if (hit.broke) {
        sound.current.break(pan, hit.maxDurability);
        if (motion) burst(side.view.particles, hit.x, hit.y, color, 12 + hit.maxDurability * 4, before.tick + hit.x);
      } else {
        sound.current.hit(pan, (brick?.durability ?? 1) - 1);
        if (motion) burst(side.view.particles, hit.x, hit.y, color, 4, before.tick + hit.x);
      }
    }
    if (events.paddleBounces.length) { sound.current.paddle(pan); side.view.squash = 1; }
    for (const kind of events.caught) { sound.current.powerUp(pan, POWER_UPS[kind].good); side.view.flash = 10; }
    if (events.lifeLost) { sound.current.lose(pan); side.view.shake = 14; }
  }, []);

  const askJevFor = useCallback((match: Match) => {
    const gen = match.gen;
    const stats = match.stats;
    stats.pending = true;
    stats.calls++;
    // Ask about the board as it will stand when the answer lands, going by
    // this match's median answer so far, or the title screen's probe before
    // the first. Asking about the board on screen cost the stand-in, at live
    // Jev's 728 ms, every ball on every level (`pnpm fair`).
    const leadTicks = Math.ceil((median(stats.ms) ?? probeMs.current) / TICK_MS);
    void askJev(askForDecision(boardAhead(match.jev.state, leadTicks))).then(answer => {
      if (game.current !== match || match.gen !== gen) return;
      stats.pending = false;
      if (answer.ok) {
        match.jev.state = applyDecision(match.jev.state, answer.decision);
        stats.answered++;
        stats.offlineStreak = 0;
        stats.lastChoice = answer.choice;
        stats.lastMs = answer.ms;
        stats.ms.push(answer.ms);
        return;
      }
      if (answer.kind === 'timeout') stats.timeouts++;
      else stats.errors++;
      if (answer.kind === 'offline') {
        stats.offlineStreak++;
        match.offlineReason = answer.reason;
        if (stats.offlineStreak >= OFFLINE_AFTER && phaseRef.current === 'playing') setPhase('offline');
      }
    });
  }, [setPhase]);

  const tickSide = useCallback((match: Match, side: Side) => {
    if (sideStatus(side.state) !== 'playing') return;
    if (side.who === 'human') {
      const center = side.state.paddleX + side.state.paddleWidth / 2;
      const { left, right } = keys.current;
      const x = left === right ? center : center + (right ? 80 : -80);
      side.state = applyDecision(side.state, { kind: 'target', x });
    }
    if (side.serving) {
      side.state = holdServe(side.state);
      const go = side.who === 'human' ? keys.current.launch : ++side.serveWait >= JEV_SERVE_TICKS;
      if (go) {
        side.state = launch(side.state);
        side.serving = false;
        side.serveWait = 0;
        sound.current.serve(side.who === 'human' ? -0.6 : 0.6);
      }
      if (side.who === 'human') keys.current.launch = false;
      return;
    }
    const before = side.state;
    const { state, events } = arenaStep(before);
    side.state = state;
    feel(side, before, events);
    if (events.lifeLost) side.serving = true;
    if (state.completed && side.clearedAt === null) {
      side.clearedAt = match.frame;
      const bonus = clearBonus(secondsLeft(match));
      side.score += bonus;
      side.levelScore += bonus;
    }
    // Jev is asked on a steady cadence and again after any bounce, when the
    // landing point it last chose has just moved.
    if (side.who === 'jev' && !side.serving && !state.completed && (bounced(before, state) || state.tick % ARENA.askEvery === 0) && !match.stats.pending) askJevFor(match);
  }, [askJevFor, feel]);

  const tickGame = useCallback(() => {
    const match = game.current;
    match.frame++;
    tickSide(match, match.human);
    tickSide(match, match.jev);
    if (levelOver(levelSide(match.human), levelSide(match.jev), secondsLeft(match))) endLevel();
  }, [endLevel, tickSide]);

  // One fixed 60 Hz clock, whatever the display's refresh rate.
  useEffect(() => {
    let frame = 0, last = performance.now(), carry = 0, sinceHud = 0;
    const loop = (now: number) => {
      carry = Math.min(carry + now - last, 250);
      last = now;
      const match = game.current;
      const motion = !reducedMotion();
      while (carry >= TICK_MS) {
        carry -= TICK_MS;
        if (phaseRef.current === 'playing') tickGame();
        for (const side of [match.human, match.jev]) {
          const v = side.view;
          v.motion = motion;
          stepParticles(v.particles);
          v.squash = Math.max(0, v.squash - 0.12);
          v.shake = Math.max(0, v.shake - 1);
          v.flash = Math.max(0, v.flash - 1);
          const ball = side.state.balls[0];
          if (ball && phaseRef.current === 'playing' && !side.serving) { v.trail.push({ x: ball.x, y: ball.y }); if (v.trail.length > 7) v.trail.shift(); }
          if (side.serving) v.trail.length = 0;
        }
      }
      for (const side of [match.human, match.jev]) {
        const status = sideStatus(side.state);
        const v = side.view;
        const live = phaseRef.current === 'playing';
        v.dim = status !== 'playing';
        // Board captions speak only during play; the screens say the rest.
        v.banner = !live ? null : status === 'cleared' ? 'CLEARED' : status === 'out' ? 'OUT OF BALLS' : side.serving ? (side.who === 'human' ? 'SPACE TO LAUNCH' : 'JEV SERVES') : null;
        v.sub = !live ? null : status === 'out' ? 'waiting for the other board' : side.serving && side.who === 'human' ? '← → to aim · Space or ↑ to launch' : null;
      }
      if (humanCanvas.current) drawBoard(humanCanvas.current, match.human.state, match.human.view);
      if (jevCanvas.current) drawBoard(jevCanvas.current, match.jev.state, match.jev.view);
      if (++sinceHud >= 6) { sinceHud = 0; setHud(snapshot(match)); }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [tickGame]);

  // Arrow keys are the whole control surface; Space or Enter confirms a screen.
  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(key)) event.preventDefault();
      sound.current.wake();
      if (key === 'ArrowLeft') keys.current.left = true;
      if (key === 'ArrowRight') keys.current.right = true;
      if (key === 'm' || key === 'M') { sound.current.muted = !sound.current.muted; setMuted(sound.current.muted); }
      if (event.repeat) return;
      const confirm = key === ' ' || key === 'Enter';
      const current = phaseRef.current;
      if (current === 'playing') {
        if (key === ' ' || key === 'ArrowUp') keys.current.launch = true;
        if (key === 'p' || key === 'P' || key === 'Escape') setPhase('paused');
      } else if (current === 'paused') {
        if (confirm || key === 'p' || key === 'P' || key === 'Escape') setPhase('playing');
      } else if (current === 'banner') {
        if (confirm || key === 'ArrowUp') setPhase('playing');
      } else if (current === 'levelEnd') {
        if (confirm) advance();
      } else if (current === 'final') {
        if (confirm) setPhase('title');
      } else if (current === 'title') {
        if (confirm && probe !== 'checking' && probe.ok) startGame();
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') keys.current.left = false;
      if (event.key === 'ArrowRight') keys.current.right = false;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
  }, [advance, probe, setPhase, startGame]);

  // The level banner steps aside on its own.
  useEffect(() => {
    if (phase !== 'banner') return;
    const timer = setTimeout(() => { if (phaseRef.current === 'banner') setPhase('playing'); }, 2200);
    return () => clearTimeout(timer);
  }, [phase, setPhase]);

  // A read-only hook for scripted play-throughs; it steers nothing.
  useEffect(() => {
    (window as unknown as { __arena: unknown }).__arena = {
      read: () => {
        const match = game.current;
        const side = (s: Side) => ({ ...snapshot(match)[s.who], paddle: s.state.paddleX + s.state.paddleWidth / 2, paddleWidth: s.state.paddleWidth, balls: s.state.balls.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy })), powerUps: s.state.powerUps.map(p => ({ x: p.x, y: p.y, kind: p.kind })), bricksLeft: s.state.bricks.filter(b => !b.unbreakable && b.durability > 0).length });
        return { phase: phaseRef.current, level: match.level, seconds: secondsLeft(match), human: side(match.human), jev: side(match.jev), stats: match.stats, results: match.results };
      },
    };
  }, []);

  const match = game.current;
  const { stats } = hud;
  const jevMedian = median(stats.ms);
  const levelName = title(levelNames[hud.level]);
  const last = match.results.at(-1);
  const wins = (who: 'human' | 'jev') => { const n = match.results.filter(r => r.winner === who).length; return `${n} ${n === 1 ? 'level' : 'levels'}`; };

  return (
    <div className="app">
      <header className="hud">
        <SideScore who="human" label="You" side={hud.human} />
        <div className="hud-center">
          <span className="hud-level">Level {hud.level + 1}<small>/{ARENA.levels}</small></span>
          <span className="hud-name">{levelName}</span>
          <span className={`hud-clock${hud.seconds < 15 && phase === 'playing' ? ' low' : ''}`}>{clock(hud.seconds)}</span>
        </div>
        <SideScore who="jev" label="Jev" side={hud.jev} />
      </header>

      <main className="arena">
        <figure className="board human">
          <figcaption><span className="tag human">You</span><span className="hint">← → move · Space launch</span></figcaption>
          <canvas ref={humanCanvas} width={960} height={640} aria-label="Your board" />
        </figure>
        <figure className="board jev">
          <figcaption>
            <span className="tag jev">Jev</span>
            <span className="hint">
              {stats.pending ? <span className="thinking">thinking</span> : stats.lastChoice ? <>chose <b>{stats.lastChoice}</b></> : 'waiting to serve'}
              {stats.lastMs !== null && <> · {stats.lastMs} ms</>}
            </span>
          </figcaption>
          <canvas ref={jevCanvas} width={960} height={640} aria-label="Jev's board" />
          <div className="jev-meter">
            <span>{stats.answered}/{stats.calls} answered</span>
            <span>median {jevMedian ?? '—'} ms</span>
            <span className={stats.timeouts ? 'warn' : ''}>{stats.timeouts} late</span>
            <span className={stats.errors ? 'warn' : ''}>{stats.errors} failed</span>
          </div>
        </figure>

        {phase === 'title' && (
          <Overlay>
            <p className="eyebrow">A TypeSafe Jev tech demo</p>
            <h1 className="logo">Brick<span>Arena</span></h1>
            <p className="lede">Five levels. One seed. You on the arrow keys, Jev on the other board. First to clear a level takes it; the higher total after five wins.</p>
            <ul className="legend">
              {Object.entries(POWER_UPS).map(([kind, look]) => (
                <li key={kind}><i style={{ background: look.color }} className={look.good ? '' : 'bad'}>{look.glyph}</i>{look.label}</li>
              ))}
            </ul>
            <JevLink probe={probe} onRetry={() => void checkJev()} />
            <button className="primary" disabled={probe === 'checking' || !probe.ok} onClick={startGame}>Start</button>
            <p className="keys">Enter to start · ← → move · Space or ↑ launch · P pause · M {muted ? 'unmute' : 'mute'}</p>
          </Overlay>
        )}

        {phase === 'banner' && (
          <Overlay compact>
            <p className="eyebrow">Level {hud.level + 1} of {ARENA.levels}</p>
            <h2 className="banner">{levelName}</h2>
            <p className="keys">Space to begin</p>
          </Overlay>
        )}

        {phase === 'paused' && (
          <Overlay compact>
            <h2 className="banner">Paused</h2>
            <p className="keys">P or Space to resume</p>
          </Overlay>
        )}

        {phase === 'offline' && (
          <Overlay compact>
            <p className="eyebrow warn">The game is paused</p>
            <h2 className="banner">Jev is offline</h2>
            <p className="lede">{match.offlineReason}</p>
            <div className="row">
              <button className="primary" onClick={() => void retryJev()}>{probe === 'checking' ? 'Checking…' : 'Retry'}</button>
              <button onClick={() => setPhase('title')}>Quit</button>
            </div>
          </Overlay>
        )}

        {phase === 'levelEnd' && last && (
          <Overlay compact>
            <p className="eyebrow">Level {last.level + 1} · {title(levelNames[last.level])}</p>
            <h2 className={`banner ${last.winner}`}>{last.winner === 'human' ? 'You take it' : last.winner === 'jev' ? 'Jev takes it' : 'Dead even'}</h2>
            <div className="tally">
              <div className="human"><b>{last.human}</b><small>{last.humanCleared ? 'cleared' : 'this level'}</small></div>
              <div className="jev"><b>{last.jev}</b><small>{last.jevCleared ? 'cleared' : 'this level'}</small></div>
            </div>
            <p className="keys">{last.level + 1 < ARENA.levels ? `Space for level ${last.level + 2}` : 'Space for the final score'}</p>
          </Overlay>
        )}

        {phase === 'final' && (
          <Overlay>
            <p className="eyebrow">Final</p>
            <h2 className={`banner big ${match.human.score > match.jev.score ? 'human' : match.jev.score > match.human.score ? 'jev' : ''}`}>
              {match.human.score > match.jev.score ? 'You win' : match.jev.score > match.human.score ? 'Jev wins' : 'A draw'}
            </h2>
            <div className="tally">
              <div className="human"><b>{match.human.score}</b><small>you · {wins('human')}</small></div>
              <div className="jev"><b>{match.jev.score}</b><small>Jev · {wins('jev')}</small></div>
            </div>
            <ol className="levels">
              {match.results.map(r => (
                <li key={r.level}><span>{r.level + 1}. {title(levelNames[r.level])}</span><span className={r.winner}>{r.human} – {r.jev}</span></li>
              ))}
            </ol>
            <p className="lede small">Jev answered {stats.answered} of {stats.calls} calls, median {jevMedian ?? '—'} ms; {stats.timeouts} late, {stats.errors} failed.</p>
            <button className="primary" onClick={() => setPhase('title')}>Play again</button>
          </Overlay>
        )}
      </main>

      <footer className="keys-bar">← → move · Space or ↑ launch · P pause · M {muted ? 'unmute' : 'mute'}</footer>
    </div>
  );
}

function SideScore({ who, label, side }: { who: Who; label: string; side: SideHud }) {
  return (
    <div className={`hud-side ${who}`}>
      <span className="hud-label">{label}</span>
      <span className="hud-score">{side.score.toLocaleString()}</span>
      <span className="hud-lives" aria-label={`${side.lives} balls left`}>
        {Array.from({ length: ARENA.lives }, (_, i) => <i key={i} className={i < side.lives ? 'on' : ''} />)}
      </span>
    </div>
  );
}

function Overlay({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return <div className={`overlay${compact ? ' compact' : ''}`}><div className="card">{children}</div></div>;
}

function JevLink({ probe, onRetry }: { probe: Probe | 'checking'; onRetry: () => void }) {
  if (probe === 'checking') return <p className="link checking">Reaching Jev…</p>;
  if (probe.ok) return <p className="link ok">Jev is online · {probe.ms} ms to answer</p>;
  return (
    <p className="link offline">
      Jev is offline: {probe.reason} <button className="text" onClick={onRetry}>Retry</button>
    </p>
  );
}

const host = document.getElementById('root');
if (host) createRoot(host).render(<App />);
