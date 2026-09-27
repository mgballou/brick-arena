# Going live

What stands between this repo and a public game, in the order you do it. Each
step is one action and names the file or dashboard it touches. It comes from a
dry run of Render's build and start on 27 September 2026 (*What the dry run
found*, below). Nothing here has been done on Render, Supabase or PostHog.

On 27 September at 1:15 AM, `https://brick-arena.onrender.com/` and `/healthz`
both answered `HTTP/2 404` with `x-render-routing: no-server`: Render has no
service by that name yet.

## Steps

### Merge the stack

The PRs are stacked, each based on the one before. The repo has
*Automatically delete head branches* off, so GitHub will not move a PR's base
to `main` when the PR under it merges. Merging #5 before you move its base
would merge it into #4's branch, not `main`. Use **Create a merge commit**, not
squash: a squash gives each later PR a history that no longer matches `main`,
and its diff fills with commits `main` already has.

1. Merge #4 `ba-jev-keeps-its-balls` into `main` (GitHub, PR #4: **Ready for review**, then **Create a merge commit**).
2. On #5 `ba-match-telemetry`, change the base to `main` (**Edit** beside the title), then merge it.
3. On #6 `ba-data-collection-spec`, change the base to `main`, then merge it.
4. On #7 `ba-supabase-writes`, change the base to `main`, then merge it.
5. On #8 `ba-posthog-events`, change the base to `main`, then merge it.
6. On #9 `ba-keep-awake-and-export`, change the base to `main`, then merge it.
7. On #10 `ba-notice-and-opt-out`, change the base to `main`, then merge it.
8. Check that CI passes on `main` (GitHub → Actions → `ci.yml`).

### Render

9. Sign up at <https://dashboard.render.com> with GitHub, and give Render's GitHub app access to the private `brick-arena` repo (Render dashboard; GitHub → Settings → Applications).
10. Choose **New → Blueprint**, pick `brick-arena`, keep branch `main` (Render dashboard; reads `render.yaml`).

### Secrets

Render asks for every `sync: false` value in `render.yaml` when it creates the
Blueprint. After the stack merges there are four, not the two that
`docs/deploy.md` step 3 names.

11. `JEV_API_KEY`: paste the token in `~/.jev-key`, the value only (Render's Blueprint form).
12. `ADMIN_SECRET`: paste the output of `openssl rand -base64 24`, and keep a copy in your password manager (Render's Blueprint form).
13. `SUPABASE_URL` and `SUPABASE_SECRET_KEY`: leave them empty for now; writes stay off without `SUPABASE_WRITES=1`. If Render refuses an empty value, do steps 17 and 18 first and paste the real ones (Render's Blueprint form). The dry run could not test this form.
14. Choose **Apply**, and watch the build log end in `✓ built` (Render → brick-arena → Events).
15. Open `/healthz` and see `ok`; open `/` and see *Jev is online* on the title screen, with the data notice and its Privacy link (service URL).
16. Decide whether match records on disk must last. On the free plan they vanish when the service sleeps, 15 minutes after the last visit. Keeping them means `plan: starter`, a 1 GB disk and `MATCHES_DIR` in `render.yaml`, about $7.25 a month (`docs/deploy.md`, *Where they live, and why a disk*). Once Supabase holds the rows, free is enough.

### Supabase

17. Create the project: Free plan, region West US (Oregon), `us-west-2` (Supabase dashboard).
18. Run `supabase/migrations/20260927000000_match_record.sql`, then `20260927020000_keep_awake.sql`, in the SQL Editor (Supabase dashboard).
19. On the service set `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `SUPABASE_WRITES=1`; saving redeploys (Render → brick-arena → Environment).
20. Add the same `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as repository secrets (GitHub → Settings → Secrets and variables → Actions).
21. Run *Supabase weekly* by hand and see all three steps pass (GitHub → Actions → `supabase-weekly.yml` → **Run workflow**).
22. Play one match against live Jev and see its row in `matches` (Supabase → Table Editor).

### PostHog

23. Create the project on US Cloud, the spec's plan (<https://us.posthog.com>).
24. Turn IP capture off (PostHog → Project settings).
25. On the service set `VITE_POSTHOG_KEY` (`phc_…`), `VITE_POSTHOG_HOST=https://us.i.posthog.com` and `VITE_POSTHOG=1` (Render → brick-arena → Environment).
26. Run **Manual Deploy → Deploy latest commit**, since the page reads the three `VITE_` values when it is built (Render dashboard).
27. Play one match and see its events arrive (PostHog → Activity).
28. In a PR, replace the two *pending* lines in `privacy.html` with the real PostHog region and Supabase state, and state PostHog's free-plan event retention (`privacy.html`).

### Play it

29. In a PR, put the service URL in the README's *Play it* line, which now reads `` `<hosted URL — filled in after the deploy>` `` (`README.md`, line 26).

## Before the repo goes public

An audit of every branch on `origin`, the GitHub PR refs and the top of the
stack (`ba-notice-and-opt-out` at `6ae7d73`), on 27 September 2026. On that
day `gh repo view mgballou/brick-arena` read `PRIVATE`. Each finding is marked
**he decides** (a history rewrite, a branch deletion or the visibility) or
**a row fixes** (a change to files or a PR body, for `ba-clean-for-show` once
the stack merges).

### Secrets: none found

- `gitleaks git --log-opts=--remotes=origin` scanned 54 commits (58 with the
  four merges) on all 13 branches: no leaks.
- The literal content of `~/.jev-key` appears 0 times in `git log --all -p`.
- `JEV_API_KEY=` appears 18 times in history, each time with `dummy`, `...`
  or `<key>`, never a real key.
- The PR refs (`refs/pull/1..11/head`) hold no commit that the branches do
  not also hold, so the scan covers them too.
- The repo has no Actions secrets yet, so none of its 66 Actions runs could
  log one; the latest *Supabase weekly* run shows `SUPABASE_SECRET_KEY`
  empty. Actions logs go public with the repo.

### History

1. **he decides — one AI-attribution trailer on `main`.** `e561ac1`
   (*Open each level with a countdown…*, 25 September) ends with
   `Co-Authored-By: Claude Opus 5.5`. It sits on `main` and on all ten `ba-*`
   branches. Rewriting it means a force-push of `main` and a rebase of the
   whole stack. Even then `refs/pull/2/head` keeps it: PR #2 carried it, and
   only GitHub Support can remove a PR ref.
2. **he decides — a second trailer on a merged branch.** `f827457`
   (*Present the project as a study of how Jev plays*, 26 September) has the
   same trailer. It lives only on `ba-readme-studies-jev`, since #3 was
   squashed into `1fb18a4`, which has none. Deleting the branch hides it from
   the branch list; `refs/pull/3/head` still holds it.
3. **he decides — five 19–22 MB copies of `docs/session.ndjson`.** They are
   the five largest blobs in history. History is 113 MB raw and 8 MB packed,
   so a clone stays small, and no blob comes near GitHub's 50 MB warning. Removing them is a rewrite of every branch.

   | Blob | Size | File | Added in | At the tip of |
   | --- | --- | --- | --- | --- |
   | `a3b997d535` | 22.2 MB | `docs/session.ndjson` | `f459803` | the seven stack branches #4–#10 |
   | `be78369c0b` | 21.8 MB | `docs/session.ndjson` | `c186c7c` | `wip/brick-rebuild` only |
   | `c065904ca3` | 20.5 MB | `docs/session.ndjson` | `56761b3` | `main`, `ba-go-live`, `ba-launch-countdown`, `ba-readme-studies-jev` |
   | `8dcd4a670e` | 20.3 MB | `docs/session.ndjson` | `e17ff26` | none; in the history of `main` and every `ba-*` branch |
   | `fd6ffccd89` | 19.4 MB | `docs/session.ndjson` | `10a2fd8` | `feat/suite-green`; in the history of every branch |
   | `ec2821937f` | 0.8 MB | `docs/jev-calls.synthetic.ndjson` | `c186c7c` | `wip/brick-rebuild` only |
   | `0b5b13e98a` | 0.6 MB | `docs/screens/2026-09-27/privacy-390.png` | `6ae7d73` | `ba-notice-and-opt-out` only |
   | `06eb518a18` | 0.4 MB | `docs/jev-calls.synthetic.ndjson` | `56761b3` | `main`, `ba-go-live`, `ba-launch-countdown`, `ba-readme-studies-jev` |
   | `552d4149a7` | 0.3 MB | `docs/jev-calls.synthetic.ndjson` | `f459803` | the seven stack branches #4–#10 |
   | `5ab7f3027e` | 0.3 MB | `docs/jev-calls.synthetic.ndjson` | `e17ff26` | none; in the history of `main` and every `ba-*` branch |

4. **he decides — who the commits name.** 53 commits carry
   `matthewbuiltthat@gmail.com` as author and committer. Two carry a second
   GitHub account's noreply address, `autonomousjupiter`: `ee2df72` on
   `feat/suite-green` and `275fd16`, this branch's first commit. Three are
   GitHub web merges. All of it goes public with the repo; changing any of it
   is a rewrite.
5. **he decides — four branches outside the stack.**
   - `ba-launch-countdown`: merged as #2, nothing beyond `main`.
   - `ba-readme-studies-jev`: merged by squash as #3; its one commit is
     `f827457` (item 2).
   - `feat/suite-green`: one commit beyond `main` (`ee2df72`, 20 September),
     never a PR.
   - `wip/brick-rebuild`: two commits beyond `main` (last 23 September), never
     a PR, with its own 21.8 MB `session.ndjson`.
6. **he decides — the visibility.** Make it public only after the items above
   are settled, since a rewrite after that point cannot recall what forks and
   clones already hold.

### Files and PR text

7. **a row fixes — PR #1's body ends with the *Generated with Claude Code*
   footer.** No other PR body or comment has one. Editing the body removes it
   from the page, but GitHub shows the earlier text to anyone who opens the
   body's *edited* menu.
8. **a row fixes — `CLAUDE.md` and `AGENTS.md` name the private desk.**
   `CLAUDE.md:109–112` and `AGENTS.md:14–17` send agents to `/herdr` and
   `/asking-laila` and name Matthew and Laila. Neither skill exists outside
   this machine.
9. **a row fixes — `docs/where-it-is.md` hard-codes a home path.** Lines 11
   and 32 run `pnpm --dir ~/projects/brick-arena …`.

### Dead code

`npx --yes knip` in a clean clone of `6ae7d73`, with no knip config, reported
33 items. Read one by one against the code, none is a file or function that
nothing uses.

10. **a row fixes — 27 exports that no other file imports.** Each symbol is
    used in its own file, so only the `export` keyword can go:
    - Values: `KEEP_DAYS` (`cli/src/upkeep.ts:10`), `targetOptions`
      (`engine/src/index.ts:217`), `visitorOf` (`jev/src/proxy.ts:64`),
      `ASK_EVERY` (`jev/src/race.ts:6`), `ADMIN_REALM` and `isAdmin`
      (`server/src/admin.ts:12`, `:34`), `ROWS_DEFAULTS`
      (`server/src/rows.ts:19`), `filterParams` (`server/src/supabase.ts:109`),
      `SCHEMA` and `forgetId` (`web/src/analytics.ts:13`, `:75`), `doNotTrack`
      (`web/src/consent.ts:49`), `DEADLINE_MS` (`web/src/jev.ts:7`),
      `sentState` (`web/src/match-log.ts:21`).
    - Types: `Divergence` (`engine/src/replay.ts:5`), `Take`
      (`jev/src/cap.ts:10`), `RaceCall` (`jev/src/race.ts:8`),
      `ChoiceQuestion` and `ChoiceAnswer` (`jev/src/wire.ts:6`, `:10`),
      `Refused` (`server/src/matches.ts:33`), `LineType`, `TargetKey` and
      `Row` (`server/src/record.ts:50`, `:98`, `:174`), `Refusal`,
      `UpsertResult`, `Where`, `SelectResult` and `RemoveResult`
      (`server/src/supabase.ts:24–33`).

    Paths are under `packages/`. `docs/scoring.md` names `targetOptions` in
    prose, so it may be worth keeping.
11. **a row fixes — knip does not know `matches.html` is an entry.** It calls
    `packages/web/src/matches.ts` unused, and with it `levelTitle`, `clockOf`
    and `describe` in `server/src/record.ts`. `matches.html:10` loads the file
    and `vite.config.ts:71` builds it. A `knip.json` naming the three HTML
    entries would silence four false reports. The other two false reports are
    `psql`, the system client that `supabase.test.ts` calls, and
    `standInChoice = clearFast` in `jev/src/stand-in.ts:40`, an alias both
    names of which are imported.

### Stale docs

`README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/*.md` and `docs/specs/*.md` at
`6ae7d73`, read against the code. The README, the routes, the env var names
and the numbers all hold. Every line below but 13 is **a row fixes**. Lines marked
*check* are likely stale but rest on a dated measurement or a reading.

12. `docs/where-it-is.md:27` — *"Not yet confirmed against live Jev. The
    permission guard refused the one real call made on 24 September"* — false.
    `8089bb9` (22 September) records a live call: *HTTP 200, 728ms, choice
    "landing"*. The same file (`:73`) and `docs/scoring.md:118` cite it, and
    `docs/scoring.md:143` has a match against live Jev on 25 September.
13. `docs/where-it-is.md:41` — *"This run predates debug mode"* — still true.
    The run (`386d238`) came before debug mode (`fb2d2e7`), which now exists
    (`DEBUG` in `web/src/jev.ts`, `refusal` in `jev/src/wire.ts`). Not a
    finding.
14. `docs/where-it-is.md:43` — *"a local stand-in that always picks
    `landing`"* — the stand-in plays `clearFast` now
    (`jev/src/stand-in.ts:40`); `alwaysLanding` is the old rule. The 250 to
    550 ms still holds.
15. `docs/where-it-is.md:15–16` — *"the title screen says Jev isn't reachable
    and why"* — when Jev can't answer, the forwarder sends 503 and the browser
    shows the down page, *The game is down right now*; the reason goes to the
    server log only (`jev/src/proxy.ts`). The title screen's line shows only
    when the game server itself fails (`probeJev` in `web/src/jev.ts`).
16. `docs/where-it-is.md:18–19` — *"one failed call or three timeouts in a
    row pause the match until Retry"* — a `down` reply now ends the match on
    the down page (`web/src/main.tsx:276`) and a bad answer is ignored. Only
    `offline` or three misses (`MISSED_AFTER`) pause with Retry.
17. `docs/where-it-is.md:25` — *"The browser only ever calls `/api/jev`"* —
    *check*: it also posts to `/api/matches` (`web/src/match-log.ts`) and, when
    built with `VITE_POSTHOG=1`, to PostHog. True if it means Jev calls only.
18. `docs/where-it-is.md:82–83` — *"(it chases every power-up)"* — *check*:
    `clearFast` now chases only the extra ball or the piercing ball, and only
    when `keepsBall` is not false.
19. `docs/brick-collisions.md:54` — *"The Human clears level 1 at tick 3348"* —
    false. All 10 games in `docs/session.ndjson` end `time-limit`, and
    `CLAUDE.md:92–94` says `pnpm session` records no level cleared.
20. `docs/brick-collisions.md:58–59` — *"the replay test takes the level the
    Human clears"* — `replay.test.ts` uses `rowsFor('Human', 0)`, a level
    with no clear.
21. `docs/brick-collisions.md:60–62` — *"The synthetic Jev recording moved to
    seed 20260962, level 1"* — `SYNTHETIC` in `jev/src/synthetic.ts` is seed
    20260919, level 0, as `README.md:116` says.
22. `docs/tunings.md:112–114` — *"No tuning touches that rule"* (the
    stand-in's lost balls come from chasing power-ups) — *check*: `clearFast`
    changed on 26 September (`f459803`), and `docs/scoring.md:147–159` has lost
    balls at 728 ms falling from 461 to 63.
23. `docs/scoring.md:135–137` — *"the next match against live Jev will show"* —
    *check*: `:143` of the same file records that match, on 25 September.
24. `docs/deploy.md:24`, `:33` and `:38` — *"This branch merged to `main`"*,
    *"the two values marked `sync: false`"* (`render.yaml` has four), and a
    build command without `NODE_ENV=development` and `--yes`. The first two
    are already under *Fixes the stack needs*.
25. `docs/specs/data-collection.md:3` — *"Status: design, no code."* — built
    since: `server/src/supabase.ts`, `server/src/rows.ts`,
    `web/src/analytics.ts`, `web/src/consent.ts`, `supabase/migrations/` and
    `.github/workflows/supabase-weekly.yml`.
26. `docs/specs/data-collection.md:92–93` — *"with `VITE_DEBUG=1` the page
    loads no PostHog and sends no match lines"* — half false. PostHog stays
    off in debug, but `web/src/main.tsx:190` builds a `MatchLog` whenever the
    player has not opted out, debug or not, and the server writes it to
    `MATCHES_DIR`. Only the Supabase row writer skips a debug match
    (`server/src/rows.ts`). Decision 4 says debug play is not sent, so the
    code is what should change.
27. `docs/specs/data-collection.md:364–372` — *"Rules this changes in
    CLAUDE.md"* — *check*: a proposal that `CLAUDE.md:16–34` and `:70–76` now
    carry, so it reads as still to do.

## What the dry run found

Both runs used Node 24.21.0 and ran `render.yaml`'s `buildCommand` as written,
then its `startCommand` with `JEV_API_KEY=dummy`, `PORT=8080` and
`JEV_BASE_URL=http://127.0.0.1:18787` pointed at `pnpm jev:stub`, as
`docs/deploy.md` *Trying the hosted build locally* says. One ran in a worktree
of `origin/main` at `1fb18a4`; the other in a fresh clone of
`ba-notice-and-opt-out` (#10, the top of the stack) at `6ae7d73`.

Both build clean in about five seconds, answer `ok` on `/healthz`, and show the
down page with no board in dark mode. The stand-in's answer is refused because
the hosted server has no debug mode, which is right.

### What the stack changes about the deploy

- **Same build and start.** `buildCommand`, `startCommand`, `healthCheckPath`,
  `NODE_VERSION` and the plan do not change.
- **Three new Blueprint secrets**: `ADMIN_SECRET`, `SUPABASE_URL`,
  `SUPABASE_SECRET_KEY`, all `sync: false`.
- **Four settings set by hand, not in `render.yaml`**: `SUPABASE_WRITES`,
  `VITE_POSTHOG`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`. The three `VITE_`
  values are read at build time, so each change needs a new build.
- **One optional setting**: `MATCHES_DIR`, only with a paid disk.
- **One new dependency**: `posthog-js`. It loads only on the first event, so
  the dry run's page fetched no PostHog code.
- **Two new pages**: `dist/matches.html` and `dist/privacy.html`.
  `/privacy.html` answers 200. `/matches.html` and `/api/matches` answer 404
  with no `ADMIN_SECRET`, as `docs/deploy.md` says.
- **Two new start-up log lines**, `[matches] …` and `[supabase] …`, which say
  where records go and whether rows are written.
- **One new outside job**: `.github/workflows/supabase-weekly.yml`, which needs
  the two GitHub secrets in step 20.

### Fixes the stack needs, for its own branches

These belong in the stack's files, not this branch.

- **`docs/deploy.md` step 3 counts two `sync: false` values**; the stack's
  `render.yaml` has four. It should name all four and say what to do with the
  Supabase pair before the project exists.
- **`render.yaml` separates a comment from its keys.** The Supabase block sits
  between the comment *Jev calls allowed per visitor, and in all, per UTC day*
  and the two `JEV_CALLS_…` keys it describes.
- **`docs/deploy.md` says "This branch merged to `main`"** under *What you
  need*, from when it was one PR. It now means the whole stack.
- **The local recipe in `docs/deploy.md` races the stand-in.** `pnpm jev:stub &`
  takes a second or two to listen, so the first `/api/jev` after
  `pnpm start` can log `Jev could not be reached: ECONNREFUSED`. The stack run
  did; **Check again** then logged the stand-in's refusal. Harmless, but
  confusing on a first try.

### Not tested here

- Render's own build machine. Both installs came from this machine's pnpm
  store; Render downloads all 62 packages, and `npx --yes pnpm@11` needs the
  network at build time.
- Whether Render's Blueprint form accepts an empty `sync: false` value
  (step 13).
- The online title screen. With no live Jev, both runs show only the down
  page, which carries no data notice and no Privacy link; the notice renders
  on the online title screen (`notice.test.tsx`).
- `RENDER_GIT_COMMIT`, which the stack reads as the build's name in Supabase
  rows and PostHog events. Off Render it is unset and the build goes unnamed.

### Output: `origin/main` at `1fb18a4`

```
$ NODE_ENV=development npx --yes pnpm@11 install --frozen-lockfile && npx --yes pnpm@11 build
✓ Lockfile passes supply-chain policies (verified 2d ago)
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +52
Progress: resolved 52, reused 52, downloaded 0, added 52, done

dependencies:
+ @vitejs/plugin-react 6.1.1
+ react 19.3.0
+ react-dom 19.3.0
+ vite 8.3.0

devDependencies:
+ @types/node 26.6.2
+ @types/react 19.3.0
+ @types/react-dom 19.3.0
+ tsx 4.23.15
+ typescript 7.0.2
+ vitest 5.0.1

Done in 695ms using pnpm v11.28.0
$ tsc -b && vite build
vite v8.3.0 building client environment for production...
transforming...
✓ 22 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.39 kB │ gzip:  0.26 kB
dist/assets/index-B0VAO1qe.css    8.45 kB │ gzip:  2.68 kB
dist/assets/index-DKfAwPiO.js   262.14 kB │ gzip: 83.06 kB

✓ built in 277ms
        2.20s user 1.03s system 73% cpu 4.420 total

$ JEV_API_KEY=dummy JEV_BASE_URL=http://127.0.0.1:18787 PORT=8080 node packages/server/src/serve.ts
[jev] jev-latest at http://127.0.0.1:18787, key from the JEV_API_KEY secret
[jev] cap: 5000 calls per visitor and 50000 in all, per UTC day
Brick Arena on port 8080
[jev] down (unreachable): A stand-in answered, not Jev. It plays only in debug mode: start the dev server with VITE_DEBUG=1.

$ curl -s http://127.0.0.1:8080/healthz
ok

$ curl -sI http://127.0.0.1:8080/
HTTP/1.1 200 OK
x-content-type-options: nosniff
content-type: text/html; charset=utf-8
cache-control: no-cache

Headless Chromium, 1280×800, prefers-color-scheme: dark, after 4 s:
TEXT: A TYPESAFE JEV TECH DEMO BrickArena The game is down right now Brick Arena is you
      against Jev, and Jev can't be reached at the moment. Without Jev there is no match.
      Please try again later. Check again
CANVAS: 0
REQUESTS:
200 GET /
200 GET /assets/index-B0VAO1qe.css
200 GET /assets/index-DKfAwPiO.js
503 GET /api/jev
```

### Output: `ba-notice-and-opt-out` at `6ae7d73`

```
$ NODE_ENV=development npx --yes pnpm@11 install --frozen-lockfile && npx --yes pnpm@11 build
✓ Lockfile passes supply-chain policies (verified 37m ago)
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +62
Progress: resolved 62, reused 62, downloaded 0, added 62, done

dependencies:
+ @vitejs/plugin-react 6.1.1
+ posthog-js 1.434.14
+ react 19.3.0
+ react-dom 19.3.0
+ vite 8.3.1

devDependencies:
+ @types/node 26.6.3
+ @types/react 19.3.0
+ @types/react-dom 19.3.0
+ tsx 4.23.15
+ typescript 7.0.2
+ vitest 5.0.2

Done in 2s using pnpm v11.28.0
$ tsc -b && vite build
vite v8.3.1 building client environment for production...
transforming...
✓ 32 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                     0.46 kB │ gzip:  0.29 kB
dist/matches.html                   0.48 kB │ gzip:  0.29 kB
dist/privacy.html                   4.31 kB │ gzip:  1.89 kB
dist/assets/matches-CSdMfd_a.css    2.44 kB │ gzip:  1.03 kB
dist/assets/main-D6b9qJUx.css       8.58 kB │ gzip:  2.71 kB
dist/assets/matches-Bo4KkPAB.js     6.05 kB │ gzip:  2.78 kB
dist/assets/record-DqcYkugA.js     20.00 kB │ gzip:  7.90 kB
dist/assets/main-DhiSO0FO.js      256.09 kB │ gzip: 81.07 kB

✓ built in 267ms
        2.63s user 2.31s system 88% cpu 5.569 total

$ JEV_API_KEY=dummy JEV_BASE_URL=http://127.0.0.1:18787 PORT=8080 node packages/server/src/serve.ts
[jev] jev-latest at http://127.0.0.1:18787, key from the JEV_API_KEY secret
[jev] cap: 5000 calls per visitor and 50000 in all, per UTC day
[matches] records in <clone>/var/matches; no ADMIN_SECRET, so no one reads them
[supabase] no rows written to Supabase
Brick Arena on port 8080
[jev] down (unreachable): Jev could not be reached: ECONNREFUSED
[jev] down (unreachable): A stand-in answered, not Jev. It plays only in debug mode: start the dev server with VITE_DEBUG=1.

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/
200
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/privacy.html
200
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/matches.html
404
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/matches
404

Headless Chromium, 1280×800, prefers-color-scheme: dark, after 4 s:
TEXT: A TYPESAFE JEV TECH DEMO BrickArena The game is down right now Brick Arena is you
      against Jev, and Jev can't be reached at the moment. Without Jev there is no match.
      Please try again later. Check again
CANVAS: 0
REQUESTS:
200 GET /
200 GET /assets/main-D6b9qJUx.css
200 GET /assets/record-DqcYkugA.js
200 GET /assets/main-DhiSO0FO.js
503 GET /api/jev
```

The `ECONNREFUSED` line is the stand-in still starting (see *Fixes the stack
needs*). Both browser runs also logged one console error, the browser's own
note on the 503.

Screens: `docs/screens/2026-09-27-go-live/`.
