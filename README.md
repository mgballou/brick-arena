# Two boards, one seed

A deterministic breakout simulation: a human and a plain deterministic bot play the same level side by side. The board is pure TypeScript; React only renders it. Both players answer one categorical `Ask` at bounce cadence, and every answer carries `ms` without pausing simulation.

```sh
pnpm install
pnpm dev
pnpm test
pnpm session && pnpm compare
```

The session command writes newline-delimited telemetry to `docs/session.ndjson`; the comparison command reports completion ticks and reaction median/p95. Five levels force different decisions: multi-hit rows reward bounce planning; split walls make the reachable side depend on angle; a narrow gap trades patience for a high-value cluster; a regenerating perimeter makes neglected regions costly; and power-up hazards make accepting a drop a judgment call. The power-ups are `extra-ball` (more balls, harder tracking), `long-slow-paddle` (more reach, less speed), `piercing-ball` (less bounce control), `magnet-paddle` (safer but less lateral control), and `short-paddle` (bad when the board tempts a careless chase).

Every session record includes the seed, level, complete `Ask` (including the exact board state), decision, tick, and reaction time. That makes the state sequence replayable for a later ghost-mode comparison even though the two live boards diverge after their first different decision.

There are two comparison modes:

- **Race** compares outcomes on the same seed: completion time and bricks cleared, plus each player's own reaction-time distribution.
- **Ghost** replays one recorded player's exact decisions and asks a second `Player` the same `Ask` without applying its answer. It compares decisions, reports divergences with the faced state, and counts failed or timed-out ghost answers as missing rather than agreement.

`pnpm compare` prints both the race summary and the deterministic bot as a ghost for each recorded Human level. Pass another NDJSON session path to compare a different recording.

## Add a third player

Implement `Player` in `packages/engine/src/index.ts` (or an adapter file): provide a `name` and `decide(ask: Ask): Promise<{ decision: Decision; ms: number }>`; return a categorical `Decision`, never paddle arithmetic. The board accepts it without knowing whether it is human, deterministic, or network-backed.

## Reference read

Before building, I read [jakesgordon/javascript-breakout](https://github.com/jakesgordon/javascript-breakout), the Breakout entry linked from [open-source-games](https://github.com/bobeff/open-source-games). I took its clear update/draw split, row-based level data, and rectangle model. I changed the architecture where this brief requires it: pure state transitions, fixed-step tests, bounce-cadenced decisions, and non-blocking player answers.
