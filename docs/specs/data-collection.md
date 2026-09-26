# Data collection: what players do, what Jev does

Status: design, no code. Written 26 September 2026 for Matthew, who asked for
it that day: *"I want to know what people do, what jev does, and be able to do
something with the data later on."* Revised the same afternoon after his
answers: *"Seems like this is a tailor made use case for supabase"*, *"Post hog
too … like the key services that people use for this, not rolling our own"*,
and *"especially at this level which will likely be free."*

So: two standard services, both on their free plans, and only the glue built
here.

## The plan in one table

| Data | Goes to | Why there |
| --- | --- | --- |
| Everything about the player: sessions, device, key inputs, pauses and quits, levels reached, balls lost, results | **PostHog** | Funnels, retention, session length and dashboards are what it is built for. |
| One light event per Jev choice (question, choice, answer time, outcome), and a per-level summary | **PostHog** | "How often does Jev aim?" becomes a chart with no SQL. |
| The match record: every Jev call **with the board it was sent**, every launch and lost ball, the clear over time, each level's result | **Supabase** | Structured rows to query with SQL, join and export. PostHog is not a place to keep 0.3 KB board snapshots or replay a match. |
| Who may look | PostHog's and Supabase's own sign-ins | Both dashboards already have accounts, two-factor sign-in and export. |

What this drops from the first version of this spec, since a service already
does it: the custom event envelope and collector, the hand-built backstage
pages and charts, the custom export endpoint, and the home-made admin door.

## Where things stand

PR #5 (`ba-match-telemetry`) writes one NDJSON file per match from the browser
through `POST /api/matches` (format `packages/server/src/record.ts`, version 1),
reads it back with `pnpm match` and `/matches.html`, and lets only the holder
of `ADMIN_SECRET` read it. It fixed a loss: Chrome allows a page 64 KiB of
`keepalive` bodies over its life, so every record used to stop about a minute
in. A full stand-in match now records all 644 calls.

Nothing is live yet: no live-Jev match has been recorded, so the volumes below
rest on one measured stand-in match and an assumed 100 matches a month.

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
`schema: 1`, and `match_id` while a match plays.

| Event | Properties |
| --- | --- |
| `session_started` | `viewport`, `pointer` (`fine`/`coarse`), `tuning`, `debug` (browser and OS come from PostHog itself) |
| `title_shown` | `jev_online`, `probe_ms` |
| `rules_opened` | — |
| `match_started` | `seed`, `tuning`, `opponent` (`live`/`stand-in`) |
| `level_started` | `level`, `name` |
| `ball_lost` | `level`, `side`, `x`, `seconds_in`, `life_lost` |
| `paused`, `resumed` | `level`, `seconds_in` |
| `jev_decision` | `level`, `question`, `choice`, `outcome`, `answer_ms`, `lead_ticks` |
| `level_ended` | `level`, `winner`, `you_percent`, `jev_percent`, `jev_aim_share` |
| `match_ended` | `reason` (`final`/`down`/`left`), `you`, `jev`, `levels_won` |

PostHog takes custom properties of any count, with nested objects, up to 1 MB
an event (posthog.com/docs/data/ingestion-warnings, read 26 September 2026).
Board state stays out of it on purpose.

Inputs are recorded as the events above, not as every key press: the paddle's
path is already in the match record, and each press would multiply the count
by hundreds.

### Setup

- PostHog Cloud **EU** (Frankfurt), one project.
- `posthog-js` in the page: `autocapture: false`, `person_profiles: 'never'`
  (no person profiles, every event anonymous), IP capture off in project
  settings, `respect_dnt: true`.
- Persistence: `'memory'` keeps nothing in the browser, so each visit is a new
  anonymous visitor. Counting **returning** players needs `localStorage`
  persistence (decision 1).
- Session replay: allowed on the free plan, but the board is drawn on a canvas,
  and whether replay captures it is not verified. Try it on one session before
  counting on it (decision 3).
- Stand-in and debug play is not sent at all (decision 4).

### The first four questions, as PostHog insights

No code, only saved insights on one dashboard:

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
  opponent    text not null,         -- live | stand-in
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
  samples     jsonb not null,        -- [[frame, you%, jev%], …]
  primary key (match_id, level)
);
```

The version lives in `supabase/migrations/` in this repo, one SQL file a
change. Row-level security is on for every table with **no policies**, so the
public key can read and write nothing.

### Who writes: the game server, with the secret key

The browser keeps sending its lines to the game server (`POST /api/matches`,
as today). The server checks them as it does now (known line types, size per
write, per match and in total), then inserts rows with the Supabase **secret**
key, held on Render like `JEV_API_KEY`.

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

- **Supabase Studio** is the admin view, from day one: Table Editor to browse,
  SQL Editor for questions PostHog can't answer (for example, every board Jev
  saw before choosing `landing`), and CSV download.
- `pnpm match <id>` keeps printing one match's timeline and tally, reading
  Supabase with the secret key from Matthew's machine.
- `/matches.html`, `GET /api/matches` and `ADMIN_SECRET` from PR #5 retire once
  Supabase holds the records; the write route stays.

### Keeping it and getting it out

- **90 days** of full rows. A weekly job then deletes `jev_calls`,
  `match_events` and `level_progress` for older matches, which by then are in
  a monthly export. `matches`, with its tally, stays for good. PostHog keeps
  each `jev_decision` for its own retention.
- **Monthly export** before pruning: `pnpm export --month 2026-10` writes one
  gzipped NDJSON file per month, the same lines as record version 1, to a place
  Matthew keeps (decision 5). The Free plan includes **no backups**
  (supabase.com/pricing, read 26 September 2026), so this file is the backup.
- The export loads into DuckDB (`read_json_auto`), pandas, or back into
  Postgres with `copy`.

## Staying free: the numbers

Assumes 100 matches and about 150 sessions a month, and 1.4× the measured
bytes for Postgres row and index overhead (an estimate).

| Limit (free plan) | Expected per month | Share | What would push it over |
| --- | --- | --- | --- |
| PostHog events: 1,000,000 (posthog.com/pricing) | 644 `jev_decision` + ~35 other per match, + 3 per session ≈ **68,000** | 7% | About 1,450 matches a month. Without `jev_decision` (per-level summary only), about 25,000. |
| PostHog replays: 5,000 (posthog.com/pricing) | ≤150 sessions | 3% | 5,000 sessions a month. |
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
  rows in memory to retry, so a brief outage loses nothing. A pause lasts until
  Matthew resumes the project, so matches played meanwhile lose their records;
  PostHog still has their events.
- **Keeping it awake.** A weekly scheduled job (a GitHub Actions cron) runs one
  real insert through the API. Common practice, but since "sufficient" isn't
  defined, the job also checks the project answers and fails loudly if not, so
  Matthew hears about a pause the same week.

## Privacy, with two vendors

Data now leaves to PostHog (EU) and Supabase (region: decision 2), both
holding it on Matthew's behalf. The notice names them.

Don't collect:

- IP addresses. PostHog's IP capture is off; the game server writes to Supabase
  without them. The Jev cap still reads the address in memory per UTC day and
  never writes it.
- Names, emails, accounts, free text. The game has no text input.
- Fingerprints. No person profiles in PostHog; no device id unless decision 1
  says yes.
- Stand-in and debug play (decision 4).

Do:

- One line on the title screen: *"This game records how each match plays,
  using PostHog and Supabase, and never who you are."* with a link to a short
  page repeating this list (decision 6 for wording and opt-out).
- Honor Do Not Track (`respect_dnt: true`).
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

## Rules this changes in CLAUDE.md

- *"Do not add model SDKs, network calls …"* — the page gains `posthog-js` and
  the server gains Supabase writes. The engine stays pure; the rule should say
  so and allow these two.
- *"It holds the game only; never add who played it."* — still true of the
  Supabase record. If decision 1 allows a device id, the rule changes for
  PostHog.

## Build plan

Each row is under three hours.

| # | Work | Hours |
| --- | --- | --- |
| 1 | Matthew: create the Supabase project (Free, region per decision 2) and the PostHog project (EU); put `SUPABASE_URL`, `SUPABASE_SECRET_KEY` on Render and the PostHog project key in the page build. | 0.5 |
| 2 | `supabase/migrations/` with the four tables and RLS on, no policies. | 1 |
| 3 | Server: write each match's lines as rows with the secret key, behind the checks PR #5 has; retry buffer; log refused writes. | 2.5 |
| 4 | Weekly GitHub Actions job: keep-awake insert, pause check, 90-day prune. | 2 |
| 5 | `pnpm match` and `pnpm export` read Supabase; monthly export file. | 2.5 |
| 6 | `posthog-js` in the page with the privacy settings above; player events at the points `main.tsx` already marks. | 2.5 |
| 7 | `jev_decision` and per-level summary events. | 1 |
| 8 | PostHog dashboard: the four insights, saved. No code. | 1.5 |
| 9 | Title-screen line and privacy page; retire `/matches.html`, `GET /api/matches` and `ADMIN_SECRET`; update CLAUDE.md. | 1.5 |

About 15 hours.

## Decisions only Matthew can make

The first version's storage, door and shared-layer questions are settled
above: Supabase Free for the record, PostHog Free for players, the vendors' own
sign-ins, one project each for all apps.

1. **Returning players.** Let PostHog keep an anonymous id in the browser to
   count returning players, or keep nothing (memory only) and give that number
   up?
2. **Supabase region.** EU, to match PostHog, or the region the Render
   service runs in?
3. **Session replay.** Try it (free up to 5,000 a month), knowing the canvas
   may not record?
4. **Stand-in and debug play.** Drop it from both services (proposed), or keep
   it flagged?
5. **Where monthly exports live.** Matthew's disk, a private repo, or cloud
   storage?
6. **Notice.** The title-screen line as written, and should players get an
   opt-out beyond Do Not Track?
