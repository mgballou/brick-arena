import { parseArgs } from 'node:util';
import { MATCHES_DEFAULTS, storeFromEnv } from '../../server/src/matches.ts';
import { MATCHES_PATH, parseRecord, tallyJev, tallyLine, tallyRows, timeline, type MatchSummary } from '../../server/src/record.ts';

// Reads the match records the game server keeps (packages/server/src/record.ts).
//
//   pnpm match                          the recent matches in var/matches (or MATCHES_DIR)
//   pnpm match <id>                     one match, line by line, then Jev's tally
//   pnpm match <id> --progress --state  with the clear once a second, and each board Jev was sent
//   pnpm match --from https://brick-arena.onrender.com [<id>]   the hosted server's
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    progress: { type: 'boolean', default: false },
    state: { type: 'boolean', default: false },
  },
});

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.text();
}

const base = values.from?.replace(/\/+$/, '');
const store = base ? null : storeFromEnv(process.env);
const id = positionals[0];

function listLine(match: MatchSummary): string {
  const levels = match.levels.map(level => level.winner === null ? '?' : level.winner === 'human' ? 'you' : level.winner === 'jev' ? 'jev' : 'tie').join(' ');
  const end = match.end ? `${match.end.reason}, you ${match.end.human} to ${match.end.jev}` : 'unfinished';
  const who = match.opponent === 'live' ? 'live Jev' : 'stand-in';
  return `${match.id}  ${who}${match.debug ? ' (debug)' : ''}, ${match.tuning}  levels: ${levels || 'none'}  balls lost: you ${match.ballsLost.human}, ${who} ${match.ballsLost.jev}  ${who} ${tallyLine(match.jev)}  ${end}`;
}

if (!id) {
  const matches: MatchSummary[] = base ? (JSON.parse(await fetchText(`${base}${MATCHES_PATH}`)) as { matches: MatchSummary[] }).matches : store!.list();
  if (!matches.length) console.log(`No matches recorded in ${base ?? store!.dir}.`);
  for (const match of matches) console.log(listLine(match));
  if (matches.length === MATCHES_DEFAULTS.recent) console.log(`(the ${MATCHES_DEFAULTS.recent} most recent)`);
} else {
  const text = base ? await fetchText(`${base}${MATCHES_PATH}/${encodeURIComponent(id)}`) : store!.read(id);
  if (text === null) {
    console.error(`No match ${id} in ${store!.dir}.`);
    process.exitCode = 1;
  } else {
    const lines = parseRecord(text);
    const start = lines.find(line => line.type === 'start');
    const opponent = start?.type === 'start' && start.opponent === 'stand-in' ? 'Stand-in' : 'Jev';
    for (const row of [...timeline(lines, { progress: values.progress, state: values.state }), '', ...tallyRows(tallyJev(lines), opponent)]) console.log(row);
  }
}
