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
