# Two boards, one seed

A deterministic breakout simulation: a human and a plain deterministic bot play the same level side by side. The board is pure TypeScript; React only renders it. Both players answer one categorical `Ask` at bounce cadence, and every answer carries `ms` without pausing simulation.

```sh
pnpm install
pnpm dev
pnpm test
pnpm session && pnpm compare
```

The session command writes newline-delimited telemetry to `docs/session.ndjson`; the comparison command reports completion ticks and reaction median/p95. The level uses data-driven patterns, multi-hit bricks, unbreakable bricks, and power-up data (`extra-ball` and `long-paddle`).

## Add a third player

Implement `Player` in `packages/engine/src/index.ts` (or an adapter file): provide a `name` and `decide(ask: Ask): Promise<{ decision: Decision; ms: number }>`; return a categorical `Decision`, never paddle arithmetic. The board accepts it without knowing whether it is human, deterministic, or network-backed.

## Reference read

Before building, I read [jakesgordon/javascript-breakout](https://github.com/jakesgordon/javascript-breakout), the Breakout entry linked from [open-source-games](https://github.com/bobeff/open-source-games). I took its clear update/draw split, row-based level data, and rectangle model. I changed the architecture where this brief requires it: pure state transitions, fixed-step tests, bounce-cadenced decisions, and non-blocking player answers.
