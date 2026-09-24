import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { botPlayer, type Player } from '../../engine/src/index.ts';
import { jevPlayer, jevPlayerFromKeyFile } from '../../jev/src/player.ts';
import { raceWithLatency, summarize } from '../../jev/src/race.ts';
import { readRecording, replayTransport } from '../../jev/src/transport.ts';
import { syntheticRecording } from '../../jev/src/synthetic.ts';

// Live:   pnpm jev   (reads the TypeSafe key from ~/.jev-key; --key-file, --base-url, --model override)
// Replay: pnpm jev --replay docs/jev-calls.synthetic.ndjson
// Write the synthetic recording again: pnpm jev --write-synthetic
const { values } = parseArgs({
  options: {
    level: { type: 'string', default: '0' },
    seed: { type: 'string', default: '20260919' },
    'max-ticks': { type: 'string', default: '12000' },
    deadline: { type: 'string', default: '1000' },
    record: { type: 'string', default: 'docs/jev-calls.ndjson' },
    replay: { type: 'string' },
    out: { type: 'string', default: 'docs/jev-race.ndjson' },
    'write-synthetic': { type: 'boolean', default: false },
    'key-file': { type: 'string' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
  },
});

mkdirSync('docs', { recursive: true });
if (values['write-synthetic']) {
  const records = await syntheticRecording();
  writeFileSync('docs/jev-calls.synthetic.ndjson', records.map(record => JSON.stringify(record)).join('\n') + '\n');
  console.log(`wrote ${records.length} synthetic calls to docs/jev-calls.synthetic.ndjson`);
  process.exit(0);
}

const deadlineMs = Number(values.deadline);
let jev: Player;
let now: (() => number) | undefined;
if (values.replay) {
  // Replay in game time: a call's recorded ms moves a virtual clock, so the
  // same recording lands every answer on the same tick.
  const records = readRecording(values.replay);
  let clock = 0;
  now = () => clock;
  jev = jevPlayer({ model: records[0].request.model, name: `Jev replay (${records[0].synthetic ? 'synthetic' : 'captured'})`, transport: replayTransport(records, { wait: ms => { clock += ms; } }) });
} else {
  jev = jevPlayerFromKeyFile({ keyFile: values['key-file'], baseUrl: values['base-url'], model: values.model, recordTo: values.record, timeoutMs: deadlineMs * 2 });
  writeFileSync(values.record, '');
}

const options = { seed: Number(values.seed), level: Number(values.level), maxTicks: Number(values['max-ticks']), deadlineMs };
writeFileSync(values.out, '');
for (const [player, clock] of [[botPlayer(), undefined], [jev, now]] as const) {
  const result = await raceWithLatency(player, { ...options, now: clock });
  for (const call of result.calls) writeFileSync(values.out, JSON.stringify({ player: result.player, seed: options.seed, level: options.level, ...call }) + '\n', { flag: 'a' });
  const s = summarize(result);
  console.log(`${s.player}: ${s.finished ? 'complete' : 'not complete'} at tick ${s.ticks}; bricks ${s.bricksCleared}; lives lost ${s.livesLost}`);
  console.log(`  calls ${s.calls}, applied ${s.applied}, timeouts ${s.timeouts}, errors ${s.errors}, asks missed while waiting ${s.missedAsks}, ticks spent waiting ${s.lateTicks}`);
  console.log(`  ms median ${s.msMedian}, p95 ${s.msP95}, max ${s.msMax}`);
}
if (!values.replay) console.log(`calls recorded to ${values.record}; race rows to ${values.out}`);
