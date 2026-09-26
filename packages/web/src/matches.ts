import { ARENA } from '../../engine/src/arena';
import { clockOf, describe, isMatchId, levelTitle, MATCHES_PATH, parseRecord, tallyJev, tallyLine, tallyRows, type MatchLine, type MatchSummary, type RecordSide } from '../../server/src/record';
import './matches.css';

// The recorded matches (packages/server/src/record.ts): a list of the recent
// ones, and each one's timeline at ?id=<match id>. It reads the same routes as
// `pnpm match` and never writes. Anyone can write a record, so every value
// from one is escaped or made a number before it reaches the page.
const root = document.getElementById('matches')!;
const id = new URLSearchParams(location.search).get('id');

const esc = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const winnerOf = (winner: 'human' | 'jev' | 'tie' | null, rival: string) => winner === null ? 'unfinished' : winner === 'tie' ? 'tie' : winner === 'human' ? 'you' : rival.toLowerCase();

async function showList() {
  root.innerHTML = '<h1>Recorded matches</h1><p class="muted">Loading…</p>';
  const response = await fetch(MATCHES_PATH).catch(() => null);
  if (!response?.ok) { root.innerHTML = '<h1>Recorded matches</h1><p>The server did not answer.</p>'; return; }
  const { matches } = await response.json() as { matches: MatchSummary[] };
  const rows = matches.map(match => {
    const rival = match.opponent === 'live' ? 'Jev' : 'Stand-in';
    const levels = match.levels.map(level => `<span class="win-${esc(String(level.winner ?? 'none'))}">${esc(winnerOf(level.winner, rival))}</span>`).join(' ');
    const end = match.end ? `${match.end.reason === 'final' ? 'finished' : match.end.reason === 'down' ? 'Jev went down' : 'left'}: ${match.end.human} to ${match.end.jev}` : 'unfinished';
    return `<tr><td><a href="?id=${esc(match.id)}">${esc(new Date(match.at).toLocaleString())}</a></td><td>${rival}${match.debug ? ' (debug)' : ''}</td><td>${esc(match.tuning)}</td><td>${levels || '–'}</td><td class="num">${Number(match.ballsLost.human)} / ${Number(match.ballsLost.jev)}</td><td>${esc(tallyLine(match.jev))}</td><td>${esc(end)}</td></tr>`;
  }).join('');
  root.innerHTML = `<h1>Recorded matches</h1>
    <p class="muted">The ${matches.length} most recent, newest first. Each opens its timeline.</p>
    ${matches.length ? `<table class="list"><thead><tr><th>Started</th><th>Against</th><th>Tuning</th><th>Levels won</th><th class="num">Balls lost, you / Jev</th><th>Jev's calls</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No matches recorded yet.</p>'}`;
}

// A level's clear over time, both boards on one scale, with a mark for every
// lost ball. Hover reads the second under the pointer.
function chart(lines: MatchLine[], rival: string): string {
  const progress = lines.filter((line): line is Extract<MatchLine, { type: 'progress' }> => line.type === 'progress');
  if (!progress.length) return '<p class="muted">No clock time recorded.</p>';
  const W = 640, H = 200, L = 36, R = 64, T = 12, B = 26;
  const end = Math.max(ARENA.levelSeconds * ARENA.ticksPerSecond, ...progress.map(p => p.frame));
  const x = (frame: number) => L + (frame / end) * (W - L - R);
  const y = (percent: number) => T + (1 - percent / 100) * (H - T - B);
  const series = (side: RecordSide) => [{ frame: 0, percent: 0 }, ...progress.map(p => ({ frame: p.frame, percent: p[side].percent }))];
  const path = (side: RecordSide) => series(side).map((p, i) => `${i ? 'L' : 'M'}${x(p.frame).toFixed(1)},${y(p.percent).toFixed(1)}`).join('');
  const percentAt = (side: RecordSide, frame: number) => [...series(side)].reverse().find(p => p.frame <= frame)?.percent ?? 0;
  const grid = [0, 50, 100].map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join('');
  const ticks = Array.from({ length: Math.floor(end / 1800) + 1 }, (_, i) => i * 1800).map(f => `<text class="axis" x="${x(f)}" y="${H - 8}" text-anchor="middle">${clockOf(f).slice(0, -2)}</text>`).join('');
  const lost = lines.filter((line): line is Extract<MatchLine, { type: 'lost' }> => line.type === 'lost').map(line => {
    const cx = x(line.frame), cy = y(percentAt(line.side, line.frame));
    return `<g class="lost ${esc(String(line.side))}"><title>${esc(describe(line, rival).text)} at ${clockOf(line.frame)}</title><path d="M${cx - 5},${cy - 5}L${cx + 5},${cy + 5}M${cx - 5},${cy + 5}L${cx + 5},${cy - 5}"/></g>`;
  }).join('');
  const last = progress.at(-1)!;
  const label = (side: RecordSide, name: string) => `<text class="label ${side}" x="${x(last.frame) + 6}" y="${y(last[side].percent) + (side === 'human' ? -2 : 12)}">${name} ${Number(last[side].percent)}%</text>`;
  const data = esc(JSON.stringify(progress.map(p => [p.frame, p.human.percent, p.jev.percent])));
  return `<figure class="chart" data-points="${data}" data-rival="${esc(rival)}">
    <div class="legend"><span class="key human"></span>You <span class="key jev"></span>${esc(rival)} <span class="key-x">✕</span> ball lost</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of the level cleared over time">
      ${grid}${ticks}
      <path class="line human" d="${path('human')}"/><path class="line jev" d="${path('jev')}"/>
      ${lost}${label('human', 'You')}${label('jev', rival)}
      <line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" data-l="${L}" data-w="${W - L - R}" data-end="${end}"/>
    </svg>
    <div class="tip" hidden></div>
  </figure>`;
}

function hover(figure: HTMLElement) {
  const points = JSON.parse(figure.dataset.points!) as Array<[number, number, number]>;
  const svg = figure.querySelector('svg')!, hit = figure.querySelector<SVGRectElement>('.hit')!, cross = figure.querySelector<SVGLineElement>('.cross')!, tip = figure.querySelector<HTMLElement>('.tip')!;
  const L = Number(hit.dataset.l), Wd = Number(hit.dataset.w), end = Number(hit.dataset.end);
  hit.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect(), scale = svg.viewBox.baseVal.width / box.width;
    const frame = ((event.clientX - box.left) * scale - L) / Wd * end;
    const point = points.reduce((best, p) => Math.abs(p[0] - frame) < Math.abs(best[0] - frame) ? p : best);
    const px = L + (point[0] / end) * Wd;
    cross.setAttribute('x1', String(px)); cross.setAttribute('x2', String(px)); cross.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.style.left = `${(px / svg.viewBox.baseVal.width) * box.width}px`;
    tip.innerHTML = `<b>${clockOf(Number(point[0]))}</b><br>You ${Number(point[1])}%<br>${esc(figure.dataset.rival!)} ${Number(point[2])}%`;
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

async function showMatch(matchId: string) {
  root.innerHTML = '<p class="muted">Loading…</p>';
  const response = await fetch(`${MATCHES_PATH}/${matchId}`).catch(() => null);
  if (!response?.ok) { root.innerHTML = `<p><a href="?">← All matches</a></p><p>No match ${esc(matchId)}.</p>`; return; }
  const lines = parseRecord(await response.text());
  const start = lines.find(line => line.type === 'start');
  const rival = start?.type === 'start' && start.opponent === 'stand-in' ? 'Stand-in' : 'Jev';
  const header = lines.filter(line => line.type === 'start' || line.type === 'end').map(line => `<p>${esc(describe(line, rival).text)}</p>`).join('');
  const tally = `<section class="tally"><h2>${esc(rival)}'s choices</h2><ul>${tallyRows(tallyJev(lines), rival).map(row => `<li>${esc(row)}</li>`).join('')}</ul></section>`;
  const levels = [...new Set(lines.flatMap(line => 'level' in line ? [line.level] : []))].sort((a, b) => a - b);
  const sections = levels.map(level => {
    const own = lines.filter(line => 'level' in line && line.level === level);
    const calls = own.filter(line => line.type === 'jev');
    const rows = own.filter(line => line.type !== 'progress' && line.type !== 'level').map(line => {
      const row = describe(line, rival);
      const state = line.type === 'jev' ? `<details><summary>${esc(row.text)}</summary><pre>${esc(JSON.stringify(line.state, null, 1))}</pre></details>` : esc(row.text);
      return `<tr class="kind-${line.type}${row.side ? ` side-${esc(String(row.side))}` : ''}"><td class="num">${row.time}</td><td>${state}</td></tr>`;
    }).join('');
    const missed = calls.filter(line => line.type === 'jev' && line.outcome !== 'answered').length;
    return `<section><h2>${esc(levelTitle(level))}</h2>${chart(own, rival)}
      <p class="muted">${calls.length} calls to ${esc(rival)}${missed ? `, ${missed} not answered in time to play` : ''}. <label><input type="checkbox" class="show-calls"> Show every call, with the board it was sent</label></p>
      <table class="events hide-calls"><tbody>${rows}</tbody></table></section>`;
  }).join('');
  root.innerHTML = `<p><a href="?">← All matches</a></p><h1>Match ${esc(matchId)}</h1>${header}${tally}${sections}`;
  root.querySelectorAll<HTMLElement>('figure.chart').forEach(hover);
  root.querySelectorAll<HTMLInputElement>('.show-calls').forEach(box => box.addEventListener('change', () => box.closest('section')!.querySelector('table')!.classList.toggle('hide-calls', !box.checked)));
}

if (id && isMatchId(id)) void showMatch(id);
else void showList();
