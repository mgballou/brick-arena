# Deploying Brick Arena

The hosted page is one Node web service on [Render](https://render.com): it
serves the built page and forwards Jev's calls with your TypeSafe key, which
lives only in Render's secret store. Nothing here has been run; every step is
yours.

## Why Render

The cap on Jev calls needs one counter that every request sees, and one Node
process on Render gives that for free with the same forwarder `pnpm dev` runs.
Cloudflare Pages Functions and Vercel functions spread requests over many
instances, so the cap would need a paid or extra key-value store.

Render's free plan holds the secret. Its costs: the service sleeps after 15
minutes idle, the first visit after that waits about a minute, and it gets 750
free instance hours a month (render.com/docs/free, read 25 September 2026). A
paid instance type stays awake.

## What you need

- A Render account, signed in with GitHub, with access to the `brick-arena` repo.
- Your TypeSafe key: the token in `~/.jev-key` (the value only, not a `NAME=` prefix).
- The work you want live merged to `main`. `render.yaml` deploys `main`.

## Steps

1. **Account.** Sign up at <https://dashboard.render.com> with GitHub, and
   let Render read the `brick-arena` repo.
2. **Blueprint.** In the dashboard choose **New → Blueprint**, pick
   `brick-arena`, and keep branch `main`. Render reads `render.yaml` and lists
   one service, `brick-arena`, on the free plan.
3. **Secrets.** Render asks for every value `render.yaml` marks
   `sync: false`. For `JEV_API_KEY`, paste the TypeSafe key. For
   `ADMIN_SECRET`, paste a long random password you keep
   (`openssl rand -base64 24`); it opens the match records. Leave
   `SUPABASE_URL` and `SUPABASE_SECRET_KEY` empty until the Supabase project
   exists: writes stay off without `SUPABASE_WRITES=1` (*Match records in
   Supabase*). None of these goes anywhere else: not the repo, not the page,
   not a log.
4. **Deploy.** Choose **Apply**. Render runs `render.yaml`'s `buildCommand`
   (`NODE_ENV=development npx --yes pnpm@11 install --frozen-lockfile && npx --yes pnpm@11 build`)
   and then its `startCommand`, `node packages/server/src/serve.ts`.
5. **Check.** Run `pnpm smoke:site https://brick-arena.onrender.com` (or
   the name Render gives it). It checks that `/healthz` answers `ok` without
   calling Jev, that `/privacy.html` answers, and, in headless Chromium, that
   the title screen says *Jev is online* and shows the data notice, whose
   Privacy link opens the privacy page. It exits 1 if any check fails. The
   title screen's check is one call to Jev, as any visitor's is; PostHog drops
   an automated browser's events, and the run starts no match. It needs
   Chromium once: `pnpm exec playwright install chromium`.

After that, every push to `main` deploys again. To deploy by hand, use
**Manual Deploy** in the dashboard, or the Render CLI:
`render deploys create <service-id> --wait`.

## Settings

All of these are environment variables on the service (**Environment** in the
dashboard). Saving one redeploys.

| Name | Default | What it does |
| --- | --- | --- |
| `JEV_API_KEY` | none | The TypeSafe key. Without it every visitor sees the down page. |
| `JEV_CALLS_PER_VISITOR_PER_DAY` | 5000 | Jev calls one visitor may make per UTC day, about five full matches. |
| `JEV_CALLS_PER_DAY` | 50000 | Jev calls everyone together may make per UTC day. |
| `JEV_BASE_URL`, `JEV_MODEL` | `https://api.typesafe.ai`, `jev-latest` | Where Jev is. Leave them unset. |
| `MATCHES_DIR` | `var/matches` in the checkout | Where match records go (see *Match records*). Set it only with a disk. |
| `ADMIN_SECRET` | none | The one password that reads match records. Unset, no one reads them. |
| `SUPABASE_WRITES` | off | `1` writes each live match to Supabase as rows too (see *Match records in Supabase*). |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | none | The project's URL and its secret key (`sb_secret_…`). Writes need both and the flag. |
| `VITE_POSTHOG` | off | `1` sends the page's player events to PostHog (see *Player events in PostHog*). Read when the page is built. |
| `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | none | The PostHog project's key (`phc_…`, public by design) and its ingestion host, which names the region. Events need both and the flag. |

## When Jev is down

When TypeSafe refuses the key, runs out of credits, rate-limits, fails or times
out, the page shows *The game is down right now* and no board. Past either cap
it adds *Today's plays are used up*. The visitor sees nothing more. The
reason is in the service's **Logs**, one line each, like:

```
[jev] down (unreachable): Jev answered 402: {"error_type":"payment_required",...}
[jev] down (used-up): the day's 50000 calls are spent
```

Screens: `docs/screens/2026-09-25/`.

## Limits worth knowing

- The counts live in memory. They start again at midnight UTC, and also when
  the service restarts or wakes from sleep.
- A visitor is the first `X-Forwarded-For` address. A bot can forge that
  header to dodge the per-visitor cap. The daily total still binds it.
- Render's docs don't say which pnpm the Node runtime preloads, or whether
  `NODE_ENV` is `production` during the build, so the build command starts
  pnpm 11, which runs the pnpm that `packageManager` in `package.json` pins,
  and keeps devDependencies itself.

## Match records

The server keeps a record of every match: when it started, the level and
tuning, every launch and who made it, every lost ball (side and where), both
boards' clear once a second, each Jev call with the board it was sent and what
it chose, and the result. The browser sends the lines every five seconds, and
once more when the page closes. The server appends them to one NDJSON file per
match, named for the match: `20260926-050211-iw4brr.ndjson`. A full match is
about half a megabyte, most of it Jev's calls. The format is in
`packages/server/src/record.ts`.

Nothing about the player is kept: no address, no browser, no name.

**Only the admin reads them.** The game writes a record without signing in,
but `/matches.html`, `/api/matches` and `/api/matches/<id>` answer only a
request that carries `ADMIN_SECRET` as the password of HTTP Basic auth (any
user name). Anyone else gets 401 and nothing from the store; with no
`ADMIN_SECRET` set, everyone gets 404. The server checks it
(`packages/server/src/admin.ts`); the page and its script never hold it. The
dev server gates the same routes the same way.

To read them:

- **Page.** `https://<your service>/matches.html`. The browser asks for a
  name and password: any name, and `ADMIN_SECRET`. It lists the 50 most recent
  matches; each opens its timeline, one chart and one event list per level.
- **CLI.** `ADMIN_SECRET=... pnpm match --from https://<your service>` lists
  them, and `... pnpm match --from https://<your service> <id>` prints one. Add `--state`
  for the board behind each Jev call, and `--progress` for the clear once a
  second. Without `--from` it reads `var/matches`, where `pnpm dev` writes.

Both show Jev's tally for each match, counted from every call in the record
(`tallyJev` in `record.ts`): its calls, the target catch it chose each time,
and how many it aimed (`aim`) against played safe (`landing`). A choice that
came back too late for its level still counts, since Jev made it.

### Where they live, and why a disk

Records are files in `MATCHES_DIR` (default `var/matches` in the checkout).
A file on a disk needs no new package, no second account and no second secret,
and the one Node process that already holds the cap is the one writer.

On the free plan that directory is **not kept**: Render's free web services
lose their filesystem on every deploy, restart and sleep (render.com/docs/free,
read 26 September 2026). The records last until the service next sleeps, 15
minutes after the last visit. That is enough to read a match you just played
and not much more.

To keep them, the service needs a persistent disk, which Render offers only on
paid instances: Starter is $7 a month and a disk is $0.25 per GB a month, 1 GB
at least (render.com/docs/disks, read 26 September 2026). A disk also turns off
zero-downtime deploys, so each deploy drops the service for a few seconds.
Render's other free stores don't fit: free Postgres expires after 30 days, and
free Key Value keeps nothing on disk.

**Your step, if you want records kept.** In `render.yaml`, change `plan: free`
to `plan: starter` and add to the service:

```yaml
    disk:
      name: matches
      mountPath: /var/data
      sizeGB: 1
```

and to its `envVars`:

```yaml
      - key: MATCHES_DIR
        value: /var/data/matches
```

Merge to `main`, and Render moves the service to Starter and mounts the disk. Set
`MATCHES_DIR` only together with the disk: without one, the server can't make
`/var/data` and won't start. The server writes nothing more once its records
reach 500 MB, about 1000 matches, and no more for one match past 4 MB, so
1 GB is room enough. It refuses a match whose id is dated more than an hour
from its own clock, so no record can hold the top of the list.

## Match records in Supabase

The server can also write each live match as rows in Supabase, the store
`docs/specs/data-collection.md` settles on. It is off until the project exists:

1. Create the Supabase project: Free plan, region West US (Oregon), `us-west-2`.
2. Run `supabase/migrations/` in its SQL Editor, oldest file first, or
   `supabase db push`. The tables have row-level security on and no policies,
   so the publishable key reads and writes nothing.
3. On the service set `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and
   `SUPABASE_WRITES=1`.

The files in `MATCHES_DIR` go on as before. The server writes rows after it has
answered the browser, and only for matches against live Jev outside debug
mode. When Supabase refuses a write, the log says so once per outage
(`[supabase] refused …`); the server keeps up to 4 MB of rows in memory and
tries again on the next write or after 30 seconds. A restart empties that
memory, and matches in play across it send no more rows.

### The weekly job

Supabase pauses a Free project after a week without enough database activity,
and only the dashboard's **Resume project** brings it back. Every Monday
`.github/workflows/supabase-weekly.yml` runs three steps
(`packages/cli/src/upkeep.ts`):

1. `pnpm weekly check` reads one row, and fails the run with a link to the
   project's dashboard when Supabase doesn't answer. GitHub emails whoever last
   changed the workflow's schedule about a failed scheduled run.
2. `pnpm weekly awake` inserts one row into `keep_awake`.
3. `pnpm weekly prune` deletes `jev_calls`, `match_events` and
   `level_progress` rows of matches begun more than 90 days ago, and
   `keep_awake` rows as old. `matches` keeps every row, with Jev's tally.

It needs two repository secrets (Settings → Secrets and variables →
Actions): `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, the same values as the
service's. Until they are set, and on a fork or a pull request, each step logs
`SUPABASE_URL is not set, so the … step does nothing.` and passes. Run it by
hand from the Actions tab with **Run workflow**. If the repository goes public,
GitHub turns scheduled workflows off after 60 days without repository
activity, and the job stops until someone turns it back on.

### Reading and exporting from your machine

With `SUPABASE_URL` and `SUPABASE_SECRET_KEY` set in your shell, `pnpm match`
lists and prints matches from Supabase instead of `MATCHES_DIR`; `--from`
still reads the hosted server's files.

The Free plan keeps no backups, so the monthly export is the backup. Early each
month, before the prune reaches it, run:

```bash
pnpm export                   # last month, UTC
pnpm export --month 2026-10   # a given month
```

It writes `brick-arena-<month>.ndjson.gz`, every match begun that month as
record version 1 lines, one match after another, to `--out`, else
`BRICK_ARENA_EXPORT_DIR`, else `~/brick-arena-exports`. It never replaces a
file already there unless given `--force`, since an export made after the prune
holds only each match's start and end, and it names any match it finds pruned.
Within a level the lines come back ordered by frame, which can differ from the
order the browser wrote them at one frame.

### Proving it on your machine

`pnpm test:db` runs the code above against a real Postgres and PostgREST in
Docker, with no Supabase project. It needs Docker and `psql`:

```bash
pnpm db:up      # supabase/local/compose.yml; waits until it answers
pnpm test:db    # also a CI job on every push
pnpm db:down    # stops it and drops the data
```

The stack runs Postgres 17 and the PostgREST version Supabase pins, capped at
1000 rows a read as Supabase is. An nginx gateway takes a fixed, public secret
key on `apikey` and hands PostgREST the `service_role` JWT, as Supabase's
gateway does; `supabase/local/roles.sql` makes the roles and grants a project
starts with. Each run empties the schema and applies every migration in order.
Then it:

- posts a match to the hosted server with `SUPABASE_WRITES=1`, and reads it back
  from the rows as the same record;
- exports a month of 1,250 matches and 1,200 of Jev's calls, which takes more
  than one page of each;
- runs the weekly job's check, insert and prune, and matches the prune's counts
  from `Content-Range` to the rows really gone;
- shows the publishable key can read and write nothing.

The CLIs work against it too: `SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SECRET_KEY=sb_secret_brick_arena_local pnpm weekly check`.

What it does not prove: Supabase's own key handling and gateway, which the
nginx stands in for; its limits past the row cap, such as request size and
statement timeouts; Render's network to Supabase; and the Free plan's pausing.

## Player events in PostHog

The page can send what players do, and each Jev choice in brief, to PostHog
(`docs/specs/data-collection.md`). It is off until the project exists:

1. Choose US or EU Cloud (the spec's last open question) and create the
   PostHog project. In its settings, turn IP capture off.
2. On the service set `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` (the project's
   ingestion host, `https://us.i.posthog.com` or `https://eu.i.posthog.com`)
   and `VITE_POSTHOG=1`, then redeploy: the page reads them when it is built.

Until then the page keeps its events in memory and loads no PostHog. Debug
play, stand-in matches and browsers that ask not to be tracked send nothing.

## Trying the hosted build locally

Never with the real key. A dummy key and the stand-in show the down page,
since the hosted server has no debug mode:

```sh
pnpm build
pnpm jev:stub &
until curl -s -o /dev/null --max-time 1 http://127.0.0.1:18787/; do sleep 0.2; done
JEV_API_KEY=dummy JEV_BASE_URL=http://127.0.0.1:18787 PORT=8080 pnpm start
```
