import { readFileSync } from 'node:fs';
import { botPlayer } from '../../engine/src/index.ts';
import { compareGhost, type RecordedSessionRow } from '../../engine/src/replay.ts';

const rows = readFileSync(process.argv[2] ?? 'docs/session.ndjson', 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line) as RecordedSessionRow);

const pct = (values: number[], percentile: number) => values[Math.min(values.length - 1, Math.floor(values.length * percentile))] ?? 0;
for (const player of [...new Set(rows.map(row => row.player))]) {
  const values = rows.filter(row => row.player === player && row.outcome !== 'level-complete').map(row => row.ms).sort((a, b) => a - b);
  const finish = rows.find(row => row.player === player && row.outcome === 'level-complete');
  console.log(`${player}: completion=${finish ? finish.tick : 'not reached'} ticks, reactions median=${pct(values, .5)}ms p95=${pct(values, .95)}ms decisions=${values.length}`);
}

for (const level of [...new Set(rows.filter(row => row.player === 'Human').map(row => row.level))]) {
  const session = rows.filter(row => row.player === 'Human' && row.level === level);
  const report = await compareGhost(session, botPlayer());
  console.log(`ghost level ${level}: agreement=${report.agreementRate * 100}% (${report.agreements}/${report.opportunities}), missing=${report.missingAnswers}`);
  console.log(`ghost ms: original=${JSON.stringify(report.originalMs)} ghost=${JSON.stringify(report.ghostMs)}`);
  for (const divergence of report.divergences) console.log(`divergence tick=${divergence.tick} state=${JSON.stringify(divergence.state)} recorded=${JSON.stringify(divergence.recorded)} ghost=${JSON.stringify(divergence.ghost)}`);
}
