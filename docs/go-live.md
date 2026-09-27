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
