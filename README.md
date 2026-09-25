# Brick Arena

A contained tech demo: you against TypeSafe's Jev at breakout, five levels on one seed.

**Play it: `pnpm dev`, open http://localhost:5173**

- Left and Right move your paddle; Space or Up serves; P pauses; H shows how scoring works; M mutes.
- Each level runs 90 seconds with three balls a side. The first to clear it takes it; otherwise the larger share cleared does. A level scores 10 per percent cleared plus 10 per second left at a clear, so the score leader is the one winning. A lost ball costs only the serve. The higher total after level 5 wins. [docs/scoring.md](docs/scoring.md) defines it, and Jev's prompt states it.
- Jev plays the right-hand board. The dev server reads the TypeSafe key from `~/.jev-key` when it starts and forwards Jev's calls itself, so the browser never sees the key.
- No live Jev, no game. Start checks Jev first; with no key, no answer or a stand-in answering, the title screen says Jev isn't reachable and why, and offers no match. If Jev drops mid-match (one failed call, or three timeouts in a row), the match pauses with a Retry and never goes on without it.
- Debug mode is the one way to play without Jev. `pnpm jev:stub` runs a local stand-in that aims every catch at the densest bricks (`clearFast` in `packages/jev/src/stand-in.ts`) and marks every reply `"answered_by": "stand-in"`; start the game against it with `VITE_DEBUG=1 JEV_KEY_FILE=<a file holding any token> JEV_BASE_URL=http://127.0.0.1:18787 pnpm dev`. The screen then shows a `DEBUG · stand-in` banner and names the right-hand board Stand-in, and the match record (`window.__arena.read()`) carries `debug`, `opponent` and `tuning`. Automated runs and Playwright use this mode. The endpoint overrides apply only with `JEV_KEY_FILE`, so the real key goes only to TypeSafe.
- Who answered comes from the reply, never the URL: a reply marked `answered_by: "stand-in"` is the stand-in, and one without the mark is live Jev. The proxy and the browser both refuse the stand-in outside debug mode.

## The engine

The board is pure TypeScript; React only renders it. Players answer one categorical `Ask` at bounce cadence, and every answer carries `ms` without pausing simulation. `packages/engine/src/arena.ts` layers the game's rules over it (a narrower paddle, serves, lives, scoring, level results) without changing `step`, so recorded sessions still replay. The deterministic bot stays for the tooling below; players never see it.

```sh
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

`packages/jev` holds a `Player` backed by TypeSafe's Jev, called over plain `fetch` at `POST {base}/v1/systemone`. It reads the TypeSafe key from `~/.jev-key` once, at construction, and sends it as `Authorization: Bearer`. The key never enters the environment or a recording.

```sh
pnpm smoke   # one live call: status, latency, the choice Jev made
pnpm jev     # race Jev against the deterministic bot
```

- Endpoint: `https://api.typesafe.ai`, model `jev-latest`. A `JEV_BASE_URL=` or `JEV_MODEL=` line in the key file overrides either; so do `--base-url` and `--model`.
- Key file: a bare token, or a `JEV_API_KEY=` line. `--key-file` reads another.
- The Vercel AI Gateway route (`https://ai-gateway.vercel.sh/typesafe`, `typesafe-ai/jev`) wants a Gateway key, not a TypeSafe one, and answers 401 to it.

That races Jev against the deterministic bot on level 0 (`--level`, `--seed`, `--max-ticks`, `--deadline` to change), writes every call and response to `docs/jev-calls.ndjson`, and every decision to `docs/jev-race.ndjson`.

Each `Ask` becomes one `choice` question keyed `decision`, and the answer must be one of the offered keys or the call fails:

- `target`: `landing`, `aim`, `angle-left`, `angle-right`, the four `x` values `askForDecision` offers, in that order: a dead-center catch, a catch that sends the ball into the densest bricks it can reach, and catches that send it off at 45 degrees. Every question opens with the objective and scoring from `docs/scoring.md`.
- `chase`: each falling power-up by id, plus `none`.
- `track`: each ball by id.

A call never holds the board. Its wall-clock time becomes game time at 60 ticks a second: the board keeps stepping on the last target, and the answer lands `ceil(ms / 16.7)` ticks after its ask. An 800 ms answer lands 48 ticks late and the player misses the next ask. A call with no answer by `--deadline` (1000 ms) is a timeout, and a failed call is an error; neither applies anything. The summary prints each of these: applied, timeouts, errors, asks missed while waiting, ticks spent waiting, and ms median, p95 and max.

In the web game Jev is asked about the board as it will stand when its answer lands (`boardAhead` in `arena.ts`, led by the match's median answer time), so a slow answer still fits the ball. `pnpm fair` measures what that buys: both boards on one seed, the stand-in's rule answering after `--ms` (default 728, the one live Jev call), against a player on the keys who reacts in `--react` ms. `pnpm objective` compares clear times for the stand-in's old rule (always `landing`) and its new one (always `aim`) over many seeds.

`docs/jev-calls.synthetic.ndjson` is **synthetic**: hand-written from the documented response shape by `pnpm jev --write-synthetic`, not captured from a call. Its answers follow the bot's rule, it holds one made-up failure, and it carries no times. It plays seed 20260962 on level 1, the first seed where that rule clears a level and meets all three questions. The tests replay it, and so can you:

```sh
pnpm jev --replay docs/jev-calls.synthetic.ndjson --seed 20260962 --level 1
```

`--replay` also takes a captured `docs/jev-calls.ndjson`, landing each answer as late as it was recorded.

## Reference read

Before building, I read [jakesgordon/javascript-breakout](https://github.com/jakesgordon/javascript-breakout), the Breakout entry linked from [open-source-games](https://github.com/bobeff/open-source-games). I took its clear update/draw split, row-based level data, and rectangle model. I changed the architecture where this brief requires it: pure state transitions, fixed-step tests, bounce-cadenced decisions, and non-blocking player answers.
