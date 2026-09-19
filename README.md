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

## Seat a real Jev

`packages/jev` holds a `Player` backed by TypeSafe's Jev, called over plain `fetch` at `POST {JEV_BASE_URL}/v1/systemone`. With your own key:

```sh
JEV_BASE_URL=https://ai-gateway.vercel.sh/typesafe JEV_MODEL=typesafe-ai/jev JEV_API_KEY=<key> pnpm jev
```

- `JEV_BASE_URL`: the API root, without `/v1/systemone`. The value above is Vercel AI Gateway; a direct TypeSafe or OpenRouter root works if it serves the same route.
- `JEV_MODEL`: the model id for that route (`typesafe-ai/jev` on the Gateway).
- `JEV_API_KEY`: sent as `Authorization: Bearer`. The player reads all three once, at construction, and refuses to build if any is missing. The key never reaches a recording.

That races Jev against the deterministic bot on level 0 (`--level`, `--seed`, `--max-ticks`, `--deadline` to change), writes every call and response to `docs/jev-calls.ndjson`, and every decision to `docs/jev-race.ndjson`.

Each `Ask` becomes one `choice` question keyed `decision`, and the answer must be one of the offered keys or the call fails:

- `target`: `landing`, `center`, `left`, `right`, the four `x` values `askForDecision` offers, in that order.
- `chase`: each falling power-up by id, plus `none`.
- `track`: each ball by id.

A call never holds the board. Its wall-clock time becomes game time at 60 ticks a second: the board keeps stepping on the last target, and the answer lands `ceil(ms / 16.7)` ticks after its ask. An 800 ms answer lands 48 ticks late and the player misses the next ask. A call with no answer by `--deadline` (1000 ms) is a timeout, and a failed call is an error; neither applies anything. The summary prints each of these: applied, timeouts, errors, asks missed while waiting, ticks spent waiting, and ms median, p95 and max.

`docs/jev-calls.synthetic.ndjson` is **synthetic**: hand-written from the documented response shape by `pnpm jev --write-synthetic`, not captured from a call. Its answers follow the bot's rule, it holds one made-up failure, and it carries no times. The tests replay it, and so can you:

```sh
pnpm jev --replay docs/jev-calls.synthetic.ndjson
```

`--replay` also takes a captured `docs/jev-calls.ndjson`, landing each answer as late as it was recorded.

## Reference read

Before building, I read [jakesgordon/javascript-breakout](https://github.com/jakesgordon/javascript-breakout), the Breakout entry linked from [open-source-games](https://github.com/bobeff/open-source-games). I took its clear update/draw split, row-based level data, and rectangle model. I changed the architecture where this brief requires it: pure state transitions, fixed-step tests, bounce-cadenced decisions, and non-blocking player answers.
