# Brick Arena

This repository contains a deterministic TypeScript breakout simulation, a CLI
session recorder, and a small React viewer. Run `pnpm test` for the engine
tests, `pnpm build` for the typecheck/build, and `pnpm session && pnpm compare`
to refresh and summarize the telemetry in `docs/session.ndjson`.

The engine is intentionally pure: seed and elapsed ticks are inputs, while
players answer categorical `Ask` questions. Keep browser concerns in
`packages/web`, and keep session I/O in `packages/cli`. Session records include
the complete `Ask` (including its state) so a later ghost-mode tool can replay
the exact state sequence; do not reduce records to only the chosen target.

Do not add model SDKs, network calls, physics engines, or flavor naming. Level
content belongs in the engine's data tables and must preserve seeded,
repeatable stepping.

## The Jev key never reaches the browser

`~/.jev-key` holds a TypeSafe key. Only `packages/jev/src/key.ts` reads it: the
Vite plugin in `vite.config.ts` when the dev server starts, and the `jev` and
`smoke` CLIs. Never move it into an environment variable, a log, a recording or
the web bundle. To test without it, run `pnpm jev:stub` and start `pnpm dev`
with `JEV_KEY_FILE` pointing at a dummy file (see the README).

The web game's rules live in `packages/engine/src/arena.ts`, over `step`.
Change `createBoard` or `step` and the recorded fixtures in `docs/` must be
regenerated.

<!-- block:begin -->
## Agents

Delegate anything that means many reads and one conclusion. A turn in this pane
is billed its whole context, so ten commands here cost ten contexts while ten
in a subagent cost one paragraph. Reach for a workflow when the work fans out
into independent pieces that each come back with a result.

Keep two things here: the judgment call, and a single lookup.

Bound what comes back. A tool result is re-read on every later turn, so it
costs its size times the turns remaining.

You are not alone. Two skills reach the desk from any repo: `/herdr` to see and
talk to the other agents running, and `/asking-laila` to pin a note or a
question for Laila. Use them when you are stuck, cannot get further, or would
otherwise stop to ask Matthew. She wakes on a pin and answers.
<!-- block:end -->
