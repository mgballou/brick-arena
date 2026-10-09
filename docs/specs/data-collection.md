# Data collection: what players do, what Jev does

Status: implemented. The page can send player events to PostHog, and the server
can write match rows to Supabase when configured. Local match files and the
admin match reader remain available. Project creation and hosted secrets are
operator setup; see [`docs/deploy.md`](../deploy.md).

## The plan in one table

| Data | Goes to | Why there |
| --- | --- | --- |
| Selected player events: session start, match and level events, pauses, lost balls and results | **PostHog** | Funnels, retention, session length and dashboards. The game does not send raw key presses. |
| One light event per Jev choice (question, choice, answer time, outcome), and a per-level summary | **PostHog** | "How often does Jev aim?" becomes a chart with no SQL. |
| The match record: every Jev call **with the board it was sent**, every launch and lost ball, the clear over time, each level's result | **Supabase** | Structured rows to query with SQL, join and export. PostHog is not a place to keep 0.3 KB board snapshots or replay a match. |
| Who may look | Vendor dashboards, plus the server's admin match reader | Supabase rows are also available through the existing admin page and CLI. |

PostHog and Supabase add hosted analytics and row storage. They do not replace
the server's match files, `/matches.html`, its admin routes or the match CLI.

## Where things stand

Each match is also kept as a versioned NDJSON file by the server. The admin
page and `pnpm match` read those files; configured Supabase writes add a second
read path. The sample sizes below describe one stand-in match recorded on
26 September 2026; they are not a claim about current production traffic.

## Measured sizes

From the full stand-in match of 26 September (`20260926-150157-fw8ap7`, five
levels, 6 min 43 s):

| Line type | Lines | Bytes each |
| --- | --- | --- |
| Jev call (`jev`) | 644 | 499, of which the board is 329 |
| Clear once a second (`progress`) | 378 | 170 |
| Launch, lost ball, level, level end, start, end | 31 | 50–220 |
| **Whole match** | **1,053** | **389 KB** |

## PostHog: players, and Jev's choices in brief

### Events

Autocapture off, so only these count against the free allowance. Names are
`snake_case`; every event carries `app: "brick-arena"`, `build` (git SHA),
`schema: 1`, and `match_id` while a match plays, except `match_ended`, which is
captured after the tracker clears the current match id.

| Event | Properties |
| --- | --- |
| `session_started` | `viewport`, `pointer` (`fine`/`coarse`), `tuning` (browser and OS come from PostHog itself) |
| `title_shown` | `jev_online`, `probe_ms` |
| `rules_opened` | — |
| `match_started` | `seed`, `tuning` |
| `level_started` | `level`, `name` |
| `ball_lost` | `level`, `side`, `x`, `seconds_in`, `life_lost` |
| `paused`, `resumed` | `level`, `seconds_in` |
| `jev_decision` | `level`, `question`, `choice`, `outcome`, `answer_ms`, `lead_ticks` |
| `level_ended` | `level`, `winner`, `you_percent`, `jev_percent`, `jev_aim_share` |
| `match_ended` | `reason` (`final`/`down`/`left`), `you`, `jev`, `levels_won` |

PostHog takes custom properties of any count, with nested objects, up to 1 MB
an event (posthog.com/docs/data/ingestion-warnings, read 26 September 2026).
Board state stays out of it on purpose.

The page sends events, not raw key presses. Match records do not contain the
paddle's full path.

### Setup

- PostHog Cloud, one project. Choose US or EU when creating it; this note
  recommends US (see *Regions*).
- `posthog-js` in the page: `autocapture: false`, `person_profiles: 'never'`
  (no person profiles, every event anonymous), IP capture off in project
  settings, `respect_dnt: true`, `disable_session_recording: true`.
- Persistence: `'localStorage'` (decision 1). `posthog-js` makes a random
  anonymous id on the first visit and keeps it in the browser, so a returning
  player counts once. The page never calls `identify`, so the id stays linked
  to nothing; clearing site data or opting out ends it.
- Session replay: off (decision 3).
- Stand-in and debug play reaches neither service (decision 4): with
  `VITE_DEBUG=1` the page loads no PostHog, and the server writes no Supabase
  row for a debug or stand-in match (`rows.ts`). Debug play runs only under
  `pnpm dev`, so its match lines stay in `MATCHES_DIR` on that machine.

### The first four questions, as PostHog insights

`pnpm posthog:dashboard` creates or updates these four insights on the
`Brick Arena` dashboard. It needs `POSTHOG_HOST`, `POSTHOG_PROJECT_ID` and
`POSTHOG_PERSONAL_API_KEY` in the environment.

1. **How often does Jev aim?** Trend of `jev_decision` where
   `question = target`, broken down by `choice`, by level and by `build`.
2. **Where do players lose balls?** `ball_lost` where `side = human`,
   broken down by `level`, with `x` and `seconds_in` as histograms.
3. **How long do sessions last, and where do people stop?** Session length
   from PostHog's own sessions, and a funnel `session_started` →
   `match_started` → `level_started (level 1…5)` → `match_ended`.
4. **How fast does Jev answer, and what does late cost?** `answer_ms`
   percentiles, and the share of `outcome` not `answered`.

Anything deeper goes to HogQL, PostHog's SQL (posthog.com/docs/hogql, read
26 September 2026; its SQL API is free during public beta, later pricing not
stated).

## Supabase: the match record as rows

### Tables

```sql
create table matches (
  id          text primary key,      -- 20260926-150157-fw8ap7
  app         text not null default 'brick-arena',
  started_at  timestamptz not null,
  ended_at    timestamptz,
  seed        integer not null,
  tuning      text not null,
  opponent    text not null,         -- always live; kept to match record v1
  end_reason  text,                  -- final | down | left
  score_you   integer,
  score_jev   integer,
  jev_tally   jsonb,                 -- tallyJev, kept after pruning
  build       text
);

create table jev_calls (
  match_id    text not null references matches on delete cascade,
  n           integer not null,      -- order within the match
  level       smallint not null,
  frame       integer not null,
  tick        integer not null,      -- the board on screen when asked
  lead        smallint not null,
  question    text not null,
  options     jsonb not null,
  choice      text,
  outcome     text not null,
  answer_ms   integer not null,
  state       jsonb not null,        -- the board sent
  primary key (match_id, n)
);

create table match_events (          -- launch, lost ball, level start and end
  match_id    text not null references matches on delete cascade,
  n           integer not null,
  type        text not null,
  level       smallint,
  frame       integer,
  data        jsonb not null,
  primary key (match_id, n)
);

create table level_progress (        -- the clear once a second, one row a level
  match_id    text not null references matches on delete cascade,
  level       smallint not null,
  samples     jsonb not null,        -- [[frame, human, jev], …], each side a SideTotal
  primary key (match_id, level)
);

create table keep_awake (            -- weekly check that the project answers
  at          timestamptz primary key default now()
);
```

The version lives in `supabase/migrations/` in this repo, one SQL file a
change. `tick` and each side's whole total in `samples` go beyond the first
draft of these tables, so the monthly export can rebuild record version 1
lines. Row-level security is on for every table with **no policies**, so the
public key can read and write nothing.

### Who writes: the game server, with the secret key

The browser sends match lines to the game server (`POST /api/matches`). The
server validates them, appends them to the local match file, and queues row
writes with the Supabase **secret** key. Writes are disabled until
`SUPABASE_WRITES=1` and both project credentials are set. Stand-in and debug
matches do not produce Supabase rows.

Why not let the browser insert straight into Supabase with the publishable key
under an insert-only policy:

- **Safer.** The publishable key is public by design (supabase.com/docs/guides/api/api-keys,
  read 26 September 2026: *"Safe to expose online"*). With an insert policy,
  anyone who opens the page can write any row, of any size, any number of
  times. Postgres constraints can't express "a real match, in order, under
  4 MB." The server already can, and does.
- **Simpler.** The browser's path exists and is tested; only the storage
  behind it changes. No policies to get right, and the `on conflict` and
  `return=representation` interplay with RLS isn't documented on
  supabase.com (not stated in the RLS guide, read 26 September 2026).
- Secret keys are refused from browsers anyway: *"Supabase matches on the
  `User-Agent` header and returns HTTP 401"* (same page).

### Reading it

- **Supabase Studio** can browse configured rows and run SQL queries.
- `pnpm match` reads Supabase when its URL and secret key are set; otherwise it
  reads local match files. `--from` reads files from a hosted server.
- `/matches.html`, the protected match routes and `ADMIN_SECRET` remain active;
  they read the configured match store.

### Keeping it and getting it out

- **90 days** of full rows. A weekly job then deletes `jev_calls`,
  `match_events` and `level_progress` for older matches, which by then are in
  a monthly export. `matches`, with its tally, stays for good. PostHog keeps
  each `jev_decision` for its own retention.
- **Monthly export** before pruning: `pnpm export --month 2026-10 --out <dir>`
  writes one gzipped NDJSON file per month, the same lines as record version 1,
  to a folder on Matthew's disk (decision 5). The Free plan includes **no
  backups** (supabase.com/pricing, read 26 September 2026), so this file is the
  backup, and his disk holds the only copy.
- **When it grows**, exports move to a private cloud storage bucket: once
  Brick Arena pays for a plan, or the exports outgrow a folder. Pick a bucket
  outside Supabase, since the export is Supabase's backup. Which service is
  chosen at that step.
- The export loads into DuckDB (`read_json_auto`), pandas, or back into
  Postgres with `copy`.

## Staying free: the numbers

Assumes 100 matches and about 150 sessions a month, and 1.4× the measured
bytes for Postgres row and index overhead (an estimate).

| Limit (free plan) | Expected per month | Share | What would push it over |
| --- | --- | --- | --- |
| PostHog events: 1,000,000 (posthog.com/pricing) | 644 `jev_decision` + ~35 other per match, + 3 per session ≈ **68,000** | 7% | About 1,450 matches a month. Without `jev_decision` (per-level summary only), about 25,000. |
| PostHog replays: 5,000 (posthog.com/pricing) | 0, replay is off | — | Nothing, unless replay is turned on. |
| PostHog projects: 1 per free org (posthog.com/docs/settings/projects) | 1 | — | A second app in its own project. |
| Supabase database: 500 MB (supabase.com/pricing) | 100 × 0.55 MB = 55 MB of new rows; with 90 days of full rows, **about 170 MB** held once steady | 34% | About 300 matches a month at 90 days; about 900 at 30 days. |
| Supabase egress: 5 GB | Studio reads and one ~55 MB export | ~2% | Heavy dashboards reading Supabase directly. |
| Supabase projects: 2 active per org | 1 | — | A third app with its own project. |

Held steady means: three months of full rows (3 × 55 MB) plus about 1 KB of
`matches` per match kept for good.

**Where paid would start.** PostHog bills past 1,000,000 events a month, at
about $0.00005 an event at first; that price comes from third-party summaries
of its pricing page and wants a check on posthog.com/pricing before anyone
relies on it. A billing limit can stop ingestion at any dollar amount
(posthog.com/docs/billing/limits-alerts). Supabase Pro is $25 a month: no
pausing, 8 GB of database, seven days of daily backups, spend cap on by default
(supabase.com/pricing). It would start when either the 500 MB or the pause below
starts to cost data.

## The catch: Supabase pauses idle free projects

- **Trigger.** *"A Free plan project is considered inactive if it does not
  receive sufficient user database activity over the past week"*
  (supabase.com/docs/guides/platform/free-project-pausing, read 26 September
  2026). The page does not say which activity counts, or how much. The game's
  inserts are database activity, so a week with matches should keep it awake,
  but that is inference, not a documented rule.
- **What a pause does.** Writes fail until Matthew presses **Resume project**
  in the dashboard; the page describes no automatic restore. The error a
  paused project returns is not documented. After 90 days
  paused the one-click restore is gone and the data must be moved to a new
  project by hand
  (supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause).
- **What it costs here.** Play never depends on Supabase, so the game keeps
  working. The server logs each refused write and keeps up to one match's
  rows in a bounded, process-local queue and retries transient failures. Rows
  can be dropped when the queue limit is exceeded, when Supabase permanently
  rejects them, or if the process restarts before retry. Play continues during
  an outage, but those records may be missing from Supabase; PostHog is a
  separate path.
- **Keeping it awake.** A weekly scheduled job (a GitHub Actions cron) runs one
  real insert through the API. Common practice, but since "sufficient" isn't
  defined, the job also checks the project answers and fails loudly if not, so
  Matthew hears about a pause the same week.

## Regions

Region is chosen in the vendor project setup. The Render Blueprint does not
set a region. Jev's default URL is in `packages/jev/src/key.ts` and can be
overridden with `JEV_BASE_URL`. PostHog uses the configured
`VITE_POSTHOG_HOST`; neither analytics nor Supabase writes are on the live Jev
call path.

## Privacy, with two vendors

When configured, data goes to PostHog at the project's selected region and to
Supabase at the project's region. The notice names both services.

Don't collect:

- IP addresses. PostHog's IP capture is off; the game server writes to Supabase
  without them. The Jev cap still reads the address in memory per UTC day and
  never writes it.
- Names, emails, accounts, free text. The game has no text input.
- Fingerprints. No person profiles in PostHog. The one id is PostHog's random
  anonymous id in the browser (decision 1), linked to nothing and never sent
  to Supabase. The first version of this spec warned that such an id *"may
  count as personal data in the EU and UK,"* so treat it as such.
- Session replay (decision 3).
- Stand-in and debug play (decision 4).

Do:

- One line on the title screen, as written: *"This game records how each match
  plays, using PostHog and Supabase, and never who you are."* with a link to a
  short page repeating this list, the anonymous id included (decision 6).
- Beside it, a one-click **opt-out**. It calls `posthog.opt_out_capturing()`
  and stops the page sending match lines to the server; the browser remembers
  the choice, and the same spot then offers to opt back in. Play doesn't
  change.
- Honor Do Not Track (`respect_dnt: true`) as well, with the same effect as
  the opt-out.
- Keep: PostHog events for its free retention (one year for events, per
  third-party summaries of its pricing page; confirm there); Supabase full rows
  90 days, summaries for good; monthly exports as long as Matthew keeps them.

## Serving his other apps

| Piece | Shared how | Free-plan fit |
| --- | --- | --- |
| Supabase project | One project for all apps, an `app` column on each app's tables | 2 active free projects per org, so one shared project leaves a spare. 500 MB is shared too. |
| PostHog project | One project for all apps, every event carries `app` | 1 project per free org, and PostHog has no cross-project view anyway. The 1,000,000 events are shared. |
| Sign-in | Matthew's own PostHog and Supabase accounts | Nothing to build per app. |
| Server-side writer | Each app's server writes with the secret key | PostHog and Supabase both have server libraries for Node; `dread-majesty-backstage` is Laravel, so it would use their PHP routes (not checked here). |
| Keep-awake job, monthly export, notice text | Copied per app, or one job across all apps' tables | — |

Per app: its event names, its tables and its dashboard.

## Setup still needed

The code, migrations, weekly job and local database path are in the repository.
To enable hosted collection, create the vendor projects, apply the Supabase
migrations, and set the service and page build variables described in
[`docs/deploy.md`](../deploy.md).
