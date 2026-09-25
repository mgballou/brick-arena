import { useState } from 'react';
import type { Down } from '../../jev/src/wire';
import { probeJev, type Probe } from './jev';
import { PALETTE } from './render';

// The whole page when Jev can't answer: no board, no stand-in, one way back.
// It says only that Jev can't be reached; the reason stays in the server log.
export function DownPage({ down, onProbe }: { down: Down; onProbe: (probe: Probe) => void }) {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    const probe = await probeJev();
    setChecking(false);
    onProbe(probe);
  };
  return (
    <main className="down-page">
      <div className="card down" role="alert">
        <p className="eyebrow">A TypeSafe Jev tech demo</p>
        <h1 className="logo">Brick<span>Arena</span></h1>
        <Wall />
        <h2 className="banner">The game is down right now</h2>
        <p className="lede">Brick Arena is you against Jev, and Jev can't be reached at the moment. Without Jev there is no match.</p>
        {down === 'used-up' && <p className="lede used-up">Today's plays are used up. They start again at midnight UTC.</p>}
        <p className="lede small">Please try again later.</p>
        <button className="primary" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check again'}</button>
      </div>
    </main>
  );
}

// While the first check runs: the page, and no board until Jev answers.
export function Checking() {
  return (
    <main className="down-page">
      <div className="card down" role="status">
        <p className="eyebrow">A TypeSafe Jev tech demo</p>
        <h1 className="logo">Brick<span>Arena</span></h1>
        <p className="link checking">Reaching Jev…</p>
      </div>
    </main>
  );
}

// A row of the game's bricks with the middle knocked out.
function Wall() {
  const colors = [...PALETTE.bricks, PALETTE.regen, ...[...PALETTE.bricks].reverse()];
  return (
    <div className="wall" aria-hidden="true">
      {colors.map((color, i) => <i key={i} style={{ background: color }} className={i === 3 ? 'gone' : ''} />)}
    </div>
  );
}
