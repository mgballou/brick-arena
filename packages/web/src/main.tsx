import { useEffect, useRef, useState, useCallback } from 'react';
import {
  applyDecision,
  askForDecision,
  botPlayer,
  createBoard,
  step,
  type Ask,
  type BoardState,
  type Decision,
} from '../../engine/src/index';
import {
  toRequest,
  fromResponse,
  type SystemOneResponse,
} from '../../jev/src/wire';
import './style.css';

const SEED = 20260919;
const LEVEL = 0;
const ASK_EVERY = 30;
const DEADLINE_MS = 1000;
const MAX_TICKS = 12000;
const W = 480;
const H = 320;

type DecideResult = {
  decision: Decision;
  ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type Decider = (ask: Ask) => Promise<DecideResult>;

function botDecider(): Decider {
  const bot = botPlayer();
  return (ask) => bot.decide(ask);
}

function liveDecider(apiKey: string): Decider {
  const url = 'https://api.typesafe.ai/v1/systemone';
  return async (ask) => {
    const request = toRequest(ask, 'jev-latest');
    const t0 = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body: SystemOneResponse & { message?: string } = await res.json();
    if (!res.ok) throw new Error(`${res.status}: ${body.message ?? ''}`);
    return { decision: fromResponse(ask, body), ms: Math.round(performance.now() - t0), usage: body.usage };
  };
}

function renderBoard(c: HTMLCanvasElement, s: BoardState, accent: string) {
  const ctx = c.getContext('2d')!;
  const k = c.width / s.width;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = '#0b1017';
  ctx.fillRect(0, 0, s.width, s.height);
  ctx.fillStyle = accent;
  for (const b of s.bricks) {
    if (b.durability <= 0 && !b.unbreakable) continue;
    ctx.globalAlpha = b.unbreakable ? 0.55 : 0.3 + 0.2 * b.durability;
    ctx.fillRect(b.x, b.y, b.width, b.height);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(s.paddleX, 294, s.paddleWidth, 10);
  for (const b of s.balls) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#70c1b3';
  for (const p of s.powerUps) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function describe(d: Decision): string {
  if (d.kind === 'target') return `target x=${d.x.toFixed(0)}`;
  if (d.kind === 'chase') return `chase ${d.powerUpId}`;
  return `track ${d.ballId}`;
}

type Stats = {
  answered: number;
  timeouts: number;
  errors: number;
  lastDecision: string;
  lastMs: number;
  lastUsage: { input_tokens?: number; output_tokens?: number } | null;
};

const blank: Stats = { answered: 0, timeouts: 0, errors: 0, lastDecision: '—', lastMs: 0, lastUsage: null };

function App() {
  const hCanvas = useRef<HTMLCanvasElement>(null);
  const jCanvas = useRef<HTMLCanvasElement>(null);
  const hState = useRef(createBoard(SEED, LEVEL));
  const jState = useRef(createBoard(SEED, LEVEL));
  const mx = useRef(W / 2);
  const pend = useRef(false);
  const dec = useRef<Decider>(botDecider());
  const alive = useRef(false);
  const hDoneTick = useRef<number | null>(null);
  const jDoneTick = useRef<number | null>(null);

  const [phase, setPhase] = useState<'idle' | 'playing' | 'done'>('idle');
  const [mode, setMode] = useState<'bot' | 'live'>('bot');
  const [key, setKey] = useState('');
  const [stats, setStats] = useState(blank);
  const [hTick, setHTick] = useState(0);
  const [jTick, setJTick] = useState(0);
  const [hBricks, setHBricks] = useState(0);
  const [jBricks, setJBricks] = useState(0);
  const [hLives, setHLives] = useState(0);
  const [jLives, setJLives] = useState(0);
  const [hDone, setHDone] = useState(false);
  const [jDone, setJDone] = useState(false);
  const [result, setResult] = useState('');

  useEffect(() => {
    if (hCanvas.current) renderBoard(hCanvas.current, hState.current, '#ef8354');
    if (jCanvas.current) renderBoard(jCanvas.current, jState.current, '#70c1b3');
  }, []);

  useEffect(() => {
    const el = hCanvas.current;
    if (!el) return;
    const fn = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      mx.current = Math.max(0, Math.min(W, (e.clientX - r.left) * (W / r.width)));
    };
    el.addEventListener('mousemove', fn);
    return () => el.removeEventListener('mousemove', fn);
  }, []);

  const go = useCallback(() => {
    hState.current = createBoard(SEED, LEVEL);
    jState.current = createBoard(SEED, LEVEL);
    pend.current = false;
    hDoneTick.current = null;
    jDoneTick.current = null;
    setStats(blank);
    setResult('');
    dec.current = mode === 'live' && key ? liveDecider(key) : botDecider();
    alive.current = true;
    setPhase('playing');
    setHDone(false);
    setJDone(false);
    setHBricks(0);
    setJBricks(0);
    setHLives(0);
    setJLives(0);
    setHTick(0);
    setJTick(0);
  }, [mode, key]);

  useEffect(() => {
    if (phase !== 'playing') return;
    let frame = 0;
    let lastInfo = 0;

    const tick = () => {
      const h = hState.current;
      if (!h.completed && h.tick < MAX_TICKS) {
        const pw = h.paddleWidth;
        h.paddleTargetX = Math.max(pw / 2, Math.min(W - pw / 2, mx.current));
        hState.current = step(h);
        if (hState.current.completed && hDoneTick.current === null) hDoneTick.current = hState.current.tick;
      }

      const j = jState.current;
      if (!j.completed && j.tick < MAX_TICKS) {
        jState.current = step(j);
        const s = jState.current;
        if (s.completed && jDoneTick.current === null) jDoneTick.current = s.tick;

        if (s.tick % ASK_EVERY === 0 && !pend.current && !s.completed) {
          const ask = askForDecision(s);
          pend.current = true;
          const timer = setTimeout(() => {
            if (pend.current) {
              pend.current = false;
              setStats(p => ({ ...p, timeouts: p.timeouts + 1 }));
            }
          }, DEADLINE_MS);
          dec.current(ask)
            .then(({ decision, ms, usage }) => {
              clearTimeout(timer);
              if (!pend.current) return;
              jState.current = applyDecision(jState.current, decision);
              pend.current = false;
              setStats(p => ({
                ...p,
                answered: p.answered + 1,
                lastDecision: describe(decision),
                lastMs: ms,
                lastUsage: usage ?? p.lastUsage,
              }));
            })
            .catch(() => {
              clearTimeout(timer);
              if (!pend.current) return;
              pend.current = false;
              setStats(p => ({ ...p, errors: p.errors + 1 }));
            });
        }
      }

      if (hCanvas.current) renderBoard(hCanvas.current, hState.current, '#ef8354');
      if (jCanvas.current) renderBoard(jCanvas.current, jState.current, '#70c1b3');

      const now = performance.now();
      if (now - lastInfo > 200) {
        lastInfo = now;
        const hs = hState.current;
        const js = jState.current;
        setHTick(hs.tick);
        setJTick(js.tick);
        setHBricks(hs.bricksCleared);
        setJBricks(js.bricksCleared);
        setHLives(hs.livesLost);
        setJLives(js.livesLost);
        setHDone(hs.completed);
        setJDone(js.completed);

        const hFinished = hs.completed || hs.tick >= MAX_TICKS;
        const jFinished = js.completed || js.tick >= MAX_TICKS;
        if (hFinished && jFinished && !pend.current) {
          alive.current = false;
          const ht = hDoneTick.current;
          const jt = jDoneTick.current;
          if (ht && jt) setResult(ht < jt ? 'You cleared first.' : jt < ht ? 'Jev cleared first.' : 'Tie.');
          else if (ht) setResult('You cleared; Jev did not.');
          else if (jt) setResult('Jev cleared; you did not.');
          else setResult('Neither cleared the level.');
          setPhase('done');
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">LIVE / SPLIT SCREEN</p>
          <h1>You vs Jev</h1>
          <p className="lede">
            Move your mouse over the left board to steer the paddle.
            {mode === 'live' ? " Jev's lag is the handicap it has to out-think." : ''}
          </p>
        </div>
      </header>

      {phase === 'idle' && (
        <section className="setup">
          <div className="mode-row">
            <label className={mode === 'bot' ? 'active' : ''}>
              <input type="radio" name="m" checked={mode === 'bot'} onChange={() => setMode('bot')} /> Bot (free)
            </label>
            <label className={mode === 'live' ? 'active' : ''}>
              <input type="radio" name="m" checked={mode === 'live'} onChange={() => setMode('live')} /> Live Jev
            </label>
          </div>
          {mode === 'live' && (
            <input
              type="password"
              className="key-input"
              placeholder="TypeSafe API key"
              value={key}
              onChange={e => setKey(e.target.value)}
            />
          )}
          <button onClick={go} disabled={mode === 'live' && !key}>Start</button>
        </section>
      )}

      <div className="boards">
        <section className="board">
          <div className="board-head">
            <span>01 / YOU (mouse)</span>
            <span>tick {hTick}</span>
          </div>
          <canvas width={W} height={H} ref={hCanvas} />
          <div className="board-foot">
            bricks {hBricks} · lives lost {hLives}
            {hDone && <strong> · CLEAR</strong>}
          </div>
        </section>
        <section className="board">
          <div className="board-head">
            <span>02 / {mode === 'live' ? 'JEV' : 'BOT'}</span>
            <span>tick {jTick}</span>
          </div>
          <canvas width={W} height={H} ref={jCanvas} />
          <div className="board-foot">
            bricks {jBricks} · lives lost {jLives}
            {jDone && <strong> · CLEAR</strong>}
          </div>
        </section>
      </div>

      {phase !== 'idle' && (
        <section className="jev-panel">
          <span className="label">JEV STATUS</span>
          <div className="jev-grid">
            <div><strong>{stats.answered}</strong><small>answered</small></div>
            <div><strong>{stats.timeouts}</strong><small>timeouts</small></div>
            <div><strong>{stats.errors}</strong><small>errors</small></div>
            <div><strong>{stats.lastMs}ms</strong><small>latency</small></div>
          </div>
          <p className="jev-last">Last: {stats.lastDecision}</p>
          {stats.lastUsage && (
            <p className="jev-last">
              Tokens: {stats.lastUsage.input_tokens ?? '—'} in / {stats.lastUsage.output_tokens ?? '—'} out
            </p>
          )}
        </section>
      )}

      {phase === 'done' && (
        <section className="result">
          <strong>{result}</strong>
          <span> You: tick {hTick} · Jev: tick {jTick}</span>
          <button className="restart" onClick={() => setPhase('idle')}>New game</button>
        </section>
      )}

      <footer>
        Seed {SEED} · level {LEVEL} · cadence {ASK_EVERY} ticks · deadline {DEADLINE_MS}ms
      </footer>
    </main>
  );
}

export default App;
