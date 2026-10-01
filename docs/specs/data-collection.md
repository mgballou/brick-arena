# Data collection: what players do, what Jev does

Status: built. The code is `packages/server/src/supabase.ts` and `rows.ts`,
`packages/web/src/analytics.ts` and `consent.ts`, `supabase/migrations/` and
`.github/workflows/supabase-weekly.yml`; creating the PostHog and Supabase
projects is the owner's step (`docs/deploy.md`). Written 26 September 2026
for Matthew, who asked for it that day: *"I want to know what people do, what
jev does, and be able to do something with the data later on."* Revised the
same afternoon after his answers: *"Seems like this is a tailor made use case
for supabase"*, *"Post hog too … like the key services that people use for
this, not rolling our own"*, and *"especially at this level which will likely
be free."*

So: two standard services, both on their free plans, and only the glue built
here. Revised again after his answers to the six decisions at 11:33 PM the
same day (see the last section); one question is left, PostHog's region.

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

Inputs are recorded as the events above, not as every key press: the paddle's
path is already in the match record, and each press would multiply the count
by hundreds.

### Setup

- PostHog Cloud, one project. **US or EU is the one open question**; the
  recommendation is US (see *Regions*).
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
```

The version lives in `supabase/migrations/` in this repo, one SQL file a
change. `tick` and each side's whole total in `samples` go beyond the first
draft of these tables, so the monthly export can rebuild record version 1
lines. Row-level security is on for every table with **no policies**, so the
public key can read and write nothing.

### Who writes: the game server, with the secret key

The browser keeps sending its lines to the game server (`POST /api/matches`,
as today). The server checks them as it does now (known line types, size per
write, per match and in total), refuses a match whose `start` line names the
stand-in or debug, then inserts rows with the Supabase **secret**
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
  rows in memory to retry, so a brief outage loses nothing. A pause lasts until
  Matthew resumes the project, so matches played meanwhile lose their records;
  PostHog still has their events.
- **Keeping it awake.** A weekly scheduled job (a GitHub Actions cron) runs one
  real insert through the API. Common practice, but since "sufficient" isn't
  defined, the job also checks the project answers and fails loudly if not, so
  Matthew hears about a pause the same week.

## Regions

Matthew asked with decision 2: *"not sure why we would host in the eu? is
that close to typesafe ai servers or something for low latency of our call to
jev?"* It was not. What was found on 26 September:

- **The Render service: Oregon (US West), by default.** Neither `render.yaml`
  nor `docs/deploy.md` names a region, and Render's Blueprint spec says of
  `region`: *"If omitted for other service types, the default value is
  `oregon`"* (render.com/docs/blueprint-spec, read 26 September 2026). So a
  Blueprint made from this `render.yaml` runs in Oregon. The live service's
  dashboard was not checked.
- **Jev: `https://api.typesafe.ai`, region unknown.** That is
  `JEV_DEFAULTS.baseUrl` in `packages/jev/src/key.ts`; `JEV_BASE_URL` could
  override it, and `render.yaml` doesn't. The host resolves to Cloudflare
  (104.18.24.46, 104.18.25.46), and a request from this machine was answered
  at Cloudflare's Ashburn edge (`cf-ray: …-IAD`). That is the edge nearest the
  caller, not where TypeSafe runs, and no response header names an origin
  region.
- **Why this spec chose EU for PostHog: it gave no reason.** The likely one is
  GDPR, after the first version's warning that a browser id may count as
  personal data in the EU and UK. It had nothing to do with Jev.

Where the regions matter: a Jev call goes browser → Render → TypeSafe, so only
the Render service's distance to TypeSafe changes how fast Jev answers.
PostHog and Supabase sit off that path: the page sends PostHog events in
batches, and the server writes Supabase rows after it has answered. Neither
region changes anything a player feels.

**Supabase: `us-west-2`, West US (Oregon)**, the region nearest the Render
service, since the game server is its only writer
(supabase.com/docs/guides/platform/regions, read 26 September 2026: *"Each
Supabase project is deployed to one primary region"*). If the service ever
moves nearer Matthew (`region: virginia` in `render.yaml`), use `us-east-1`
(North Virginia) instead. Choose before creating the project.

**PostHog: US Cloud recommended, not decided.** Matthew is in US Eastern, the
server and database are in the US, and so, as far as anyone knows, are most
players; US Cloud keeps all the data in one country. GDPR covers EU players
wherever their data is held, so EU Cloud buys one thing: EU players' events
stay in the EU. That is worth it only if EU players become a real share. The
anonymous id is the piece GDPR would care about, and the opt-out and Do Not
Track cover it in either region. PostHog asks for the cloud at sign-up, so
this is settled before build step 1.

## Privacy, with two vendors

Data now leaves to PostHog (US or EU, the open question) and Supabase (West
US, Oregon), both holding it on Matthew's behalf. The notice names them.

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

## Rules this changed in CLAUDE.md

`CLAUDE.md` carries both now.

- *"Do not add model SDKs, network calls …"* — the page gains `posthog-js` and
  the server gains Supabase writes. The engine stays pure; the rule should say
  so and allow these two.
- *"It holds the game only; never add who played it."* — still true of the
  Supabase record. PostHog now keeps an anonymous browser id (decision 1), so
  the rule should say so and bound it: random, never identified, never in the
  match record.

## Build plan

Each row is under three hours.

| # | Work | Hours |
| --- | --- | --- |
| 1 | Matthew: settle PostHog's region; create the Supabase project (Free, `us-west-2`) and the PostHog project; put `SUPABASE_URL`, `SUPABASE_SECRET_KEY` on Render and the PostHog project key in the page build. | 0.5 |
| 2 | `supabase/migrations/` with the four tables and RLS on, no policies. | 1 |
| 3 | Server: write each match's lines as rows with the secret key, behind the checks PR #5 has; retry buffer; log refused writes. | 2.5 |
| 4 | Weekly GitHub Actions job: keep-awake insert, pause check, 90-day prune. | 2 |
| 5 | `pnpm match` and `pnpm export` read Supabase; monthly export file to a folder on Matthew's disk. | 2.5 |
| 6 | `posthog-js` in the page with the privacy settings above (anonymous id in `localStorage`, replay off, none of it in debug); player events at the points `main.tsx` already marks. | 2.5 |
| 7 | `jev_decision` and per-level summary events. | 1 |
| 8 | PostHog dashboard: the four insights, saved. No code. | 1.5 |
| 9 | Title-screen line, opt-out and privacy page; retire `/matches.html`, `GET /api/matches` and `ADMIN_SECRET`; update CLAUDE.md. | 1.5 |

About 15 hours.

## Decisions only Matthew can make

The first version's storage, door and shared-layer questions are settled
above: Supabase Free for the record, PostHog Free for players, the vendors' own
sign-ins, one project each for all apps.

Matthew answered the six on 26 September at 11:33 PM. His words, then what
the spec now says.

1. **Returning players** (anonymous id, or keep nothing). *"anon id"* —
   answered. PostHog keeps a random anonymous id in `localStorage`.
2. **Supabase region** (EU to match PostHog, or Render's). *"i am actually in
   US Eastern, which is obscurbed by my VPN at times. not sure why we would
   host in the eu? is that close to typesafe ai servers or something for low
   latency of our call to jev? whatever region is best for proximity would be
   what i think for supabase"* — answered. `us-west-2` (Oregon), nearest the
   Render service; his question is answered under *Regions*.
3. **Session replay** (try it, knowing the canvas may not record). *"skip
   it"* — answered. Replay is off.
4. **Stand-in and debug play** (drop it, or keep it flagged). *"skip it"* —
   answered. Neither service receives it.
5. **Where monthly exports live** (his disk, a private repo, or cloud
   storage). *"disk for now, cloud storage if it grows - more scalable, matches
   for something that is paid, storage is secure"* — answered. A folder on his
   disk now; a private bucket outside Supabase once the game pays for a plan
   or the exports outgrow the folder.
6. **Notice** (the line as written, and an opt-out beyond Do Not Track).
   *"your pick"* — answered by the desk's pick: the title-screen line as
   written, and a one-click opt-out beside it, on top of Do Not Track.

One question left:

7. **PostHog region.** US Cloud or EU Cloud? **Recommended: US**, because
   Matthew, the server, the database and most likely most players are in the
   US, and EU only earns its place if EU players become a real share (see
   *Regions*). Needed before build step 1, since PostHog fixes the cloud at
   sign-up.
