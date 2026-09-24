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

## Engine geometry is pinned by two committed fixtures

`docs/session.ndjson` and `docs/jev-calls.synthetic.ndjson` are recorded against
the exact ball path, so touching anything that moves it -- `paddleWidth`,
`paddleSpeed`, ball velocity, brick sizes -- reds six tests in `replay.test.ts`
and `jev.test.ts`. Regenerate both, in this order, before believing a failure:
`pnpm session` then `pnpm jev --write-synthetic`. Two failures survive
regeneration and need real work: the replay final-state check, and the test that
wants all three question kinds, which only sees `track` if an extra-ball drop
happens to fall in the recorded window.

Measured 23 September: the deterministic bot clears only level 0, and only at
`paddleWidth: 180`. At 120 it clears nothing within 12000 ticks. The bot decides
every 30 ticks, so a narrower paddle costs it far more than it costs a human on
the arrow keys -- budget for that before tuning the paddle for feel.

## The Jev key never reaches the browser

`~/.jev-key` is a **TypeSafe** key, not a Vercel AI Gateway key. The route in
`vite.config.ts` (`https://ai-gateway.vercel.sh/typesafe/v1/systemone`, model
`typesafe-ai/jev`) authenticates with a *Gateway* key and answers 401 to this
one. The direct TypeSafe endpoint is `https://api.typesafe.ai/v1/systemone` with
model `jev-latest`, which is what the pre-rebuild web client used.

Read the key only inside the dev-server plugin. Sending it to any host other
than the one endpoint in use reads as exfiltration and gets refused.

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
