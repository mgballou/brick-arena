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
repeatable stepping. The engine stays pure. The one network call the game
server adds is its writes to Supabase (`docs/specs/data-collection.md`), made
only by `packages/server/src/supabase.ts`, behind `SUPABASE_WRITES=1`, and
never on a player's path: play never waits on it or depends on it. Its
`SUPABASE_SECRET_KEY` stays on the host like `JEV_API_KEY`. Tests use the
stub there and never call live Supabase. The same file is the door for
`pnpm match`, `pnpm export` and the weekly job (`pnpm weekly`), which read the
key from the shell or a GitHub secret and do nothing when `SUPABASE_URL` is
unset. `pnpm export` writes the only backup; never make it replace a file
unasked.

The page's one addition is `posthog-js`, loaded only by
`packages/web/src/analytics.ts` and only when the build sets `VITE_POSTHOG=1`,
`VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`; unset, the bundle holds none of it
(`bundle.test.ts`). Debug play, stand-in matches and Do Not Track send nothing.
PostHog keeps a random anonymous id in `localStorage`; never call `identify`,
and never put that id in the match record. No analytics import belongs in the
engine. Tests use the in-memory stub and never call live PostHog.

## The Jev key never reaches the browser

`~/.jev-key` holds a TypeSafe key. Only `packages/jev/src/key.ts` reads it: the
Vite plugin in `vite.config.ts` when the dev server starts, and the `jev` and
`smoke` CLIs. Never move it into an environment variable, a log, a recording or
the web bundle. To test without it, run `pnpm jev:stub` and start `pnpm dev`
with `VITE_DEBUG=1` and `JEV_KEY_FILE` pointing at a dummy file (see the
README). Never call live Jev from a test.

The hosted page is the one place the key is not that file: there it is the
host's `JEV_API_KEY` secret, read by `linkFromEnv` in `key.ts` and nowhere else
(`docs/deploy.md`). `packages/jev/src/proxy.ts` is the one forwarder; the dev
server and `packages/server` both mount it at `JEV_PATH`. When Jev can't answer,
or the day's cap in `cap.ts` is spent, it sends `DOWN_STATUS` with a `Down`
reason and logs the upstream detail; the browser then shows the down page and
mounts no board. `bundle.test.ts` builds the client and fails if it holds a key
or names a TypeSafe host.

No live Jev, no game. The stand-in plays only in debug mode (`VITE_DEBUG=1`),
which says so on screen and in the match record. `refusal` in
`packages/jev/src/wire.ts` is the one gate; the proxy and the browser both
ask it. Who answered comes from the reply's `answered_by` mark, never the URL.

`docs/scoring.md` defines performance once: clearing fast. `POINTS` and
`levelWinner` in `arena.ts`, the scoring panel in `main.tsx`, and `OBJECTIVE`
and the `target` options in `packages/jev/src/wire.ts` all follow it; change
the definition and change all four. `askForDecision` builds the options, so a
change to it means regenerating `docs/session.ndjson` and the synthetic
recording.

Each match of the web game leaves a record on the server: the browser builds
the lines (`packages/web/src/match-log.ts`), `packages/server/src/matches.ts`
appends them to one NDJSON file per match in `MATCHES_DIR`, and `pnpm match`
and `/matches.html` read them. The format is `packages/server/src/record.ts`.
It holds the game only; never add who played it. Only the admin reads a
record: every route that serves one calls `refuseUnlessAdmin` in
`packages/server/src/admin.ts` against `ADMIN_SECRET`, and no secret reaches
the client.

The web game's rules live in `packages/engine/src/arena.ts`, over `step`.
Change `createBoard` or `step` and the recorded fixtures in `docs/` must be
regenerated.

`createBoard` keeps the 180-wide paddle, but its reason is gone. Measured 24
September over `step` with the deterministic bot, seed 20260919, 12000 ticks a
level: before the brick collision fix, 180 at speed 5 cleared level 0 and the
arena's 120 at speed 7 cleared none. After it, neither width clears a level. The
bot catches the ball dead center, which sends it straight up one column for
good; the old collision bug turned the ball the wrong way often enough to knock
it out of that loop. The arena escapes it with `minReturnVx`; `step` has no such
floor. The Human in `pnpm session` catches at the `landing` option, which since
26 September is where the ball really comes down (`landingOf`), so it loops too,
and `pnpm session` now records no level cleared.

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
