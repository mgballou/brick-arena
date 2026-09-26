# Data collection: what players do, what Jev does

Status: design, no code. Written 26 September 2026 for Matthew, who asked for
it on the same day: *"I want to know what people do, what jev does, and be able
to do something with the data later on."*

## Where things stand

PR #5 (`ba-match-telemetry`) keeps one NDJSON file per match, in the format of
`packages/server/src/record.ts` (version 1). The file holds every launch, lost
ball, once-a-second clear, and Jev call with the board it was sent and its
choice. `tallyJev` counts the calls; `pnpm match` and `/matches.html` read the
files, and since 26 September only the admin can (`ADMIN_SECRET`, HTTP Basic,
`packages/server/src/admin.ts`).

What it lacks, measured or read on 26 September:

- **Nothing about the player beyond the board.** No session, no device, no
  input, by design (CLAUDE.md: *"never add who played it"*). This spec changes
  that rule, so decision 2 below is Matthew's.
- **No store you can query.** Files on a disk Render's free plan wipes on every
  sleep. Every question means reading every file.
- **Writes were lossy.** Chrome gives a page 64 KiB of `keepalive` request
  bodies over its whole life. The browser sent every write with `keepalive`,
  so each match's record stopped about a minute in: 104 of 610 calls in one
  stand-in match. PR #5 now sends plain POSTs and keeps `keepalive` for the
  closing beacon, and the next match kept all 644 calls. Retries and
  de-duplication still don't exist.
- **One version, no envelope.** Lines carry `type` but no session, sequence,
  build or schema version beyond the `start` line's `v`.

## Principles

1. Record the game, and the person only as a random device id. No name, email,
   address, full user agent or free text, ever.
2. Every event carries one envelope, versioned, so a reader years from now can
   parse it without the code that wrote it.
3. The browser may retry any write; the server must make that safe.
4. Raw events are the source of truth. Analytics are queries over them, and
   any summary can be rebuilt.
5. Debug and stand-in play is flagged, never mixed into Jev's numbers.

## Event schema, version 2

### Envelope

Every event is one JSON object:

```json
{
  "v": 2,
  "app": "brick-arena",
  "session": "s_01J8Z3K4QW7",
  "seq": 41,
  "type": "jev.answer",
  "ms": 53104,
  "match": "20260926-145844-vokmtn",
  "build": "5deb2c9",
  "data": { "call": 17, "question": "target", "outcome": "answered", "choice": "aim", "clientMs": 412 }
}
```

| Field | Meaning |
| --- | --- |
| `v` | Schema version. Readers switch on it; writers never change a version's meaning. |
| `app` | Which app wrote it. Lets several apps share one store (see *Shared layer*). |
| `session` | Random id made when the page loads. One tab, one visit. |
| `seq` | 0, 1, 2… per session. With `app` and `session`, it is the event's key, so a retried write is a no-op. |
| `type` | `area.verb`, from the list below. |
| `ms` | Milliseconds since the session began, by the page's clock. |
| `match` | The match id, while one is playing. |
| `build` | Git SHA the page was built from. |
| `data` | The type's own fields. |

The server adds `received_at` (its own clock) and nothing else. It never
stores the IP address.

### Player events

| Type | `data` | Why |
| --- | --- | --- |
| `session.start` | `device`: `{ viewport: [w, h], dpr, pointer: "fine"\|"coarse", browser: "Chrome 154", os: "macOS", lang, reducedMotion }`; `deviceId`; `returning` (seen before); `referrerHost`; `tuning`; `debug` | Who can play, on what, and whether they come back. `browser` and `os` are family and major version only. |
| `session.visibility` | `{ hidden: bool }` | Idle time is not play time. |
| `session.end` | `{ reason: "pagehide"\|"title"\|"down" }` | Session length and how it ended. |
| `title.shown` | `{ probeMs, jevOnline }` | Who saw the game down, and how slow Jev's first answer was. |
| `rules.open`, `rules.close`, `sound.mute` | `{}` | Whether anyone reads the scoring panel. |
| `match.start` | `{ seed, tuning, opponent: "live"\|"stand-in", levels }` | |
| `level.start` | `{ level, name }` | |
| `input.move` | `{ frame, dir: "left"\|"right"\|"stop", paddleX }` | Key edges only, never every frame: a held key is two events. |
| `input.launch` | `{ frame, x }` | |
| `input.pause`, `input.resume`, `input.quit` | `{ frame, level }` | Where people stop. |
| `ball.launch` | `{ level, frame, side, x, first }` | As v1 `launch`. |
| `ball.lost` | `{ level, frame, side, x, lifeLost, livesLeft }` | As v1 `lost`. |
| `level.progress` | `{ level, frame, human, jev }` | Once a second, as v1 `progress`. |
| `level.end` | `{ level, frame, winner, human, jev }` | As v1 `levelEnd`. |
| `match.end` | `{ reason: "final"\|"down"\|"left", human, jev }` | As v1 `end`. |

### Jev events

v1 writes one line per call once the answer is back. v2 splits it so a call
that never returns still shows, and adds what the choice led to.

| Type | `data` | Why |
| --- | --- | --- |
| `jev.call` | `{ call, level, frame, tick, lead, question, options, state }` | `call` counts from 1 in the session. `state` is the board as sent, as v1's `SentState`. |
| `jev.answer` | `{ call, question, outcome, choice, clientMs, serverMs, upstreamMs, answeredBy, tokens: { input, output } }` | `serverMs` and `upstreamMs` come from the proxy in a response header; `tokens` from the reply's `usage`, when Jev sends it. |
| `jev.result` | `{ call, caught, frames, bricksBroken, points, ballLost }` | Written at the next paddle touch or lost ball: did this choice keep the ball, and what did it break? |

The proxy also logs `proxy.call` rows on the server (`{ session, status,
upstreamMs, cap: "ok"\|"visitor"\|"total" }`) so a call the browser never
reports, because the tab closed, still counts.

### Size

Measured 26 September: a full five-level stand-in match wrote 389 KB of v1
lines, 644 of them Jev calls, about 0.6 KB a call with the board it was sent.
Player input and the `jev.result` rows might bring a match to about 0.5 MB. At
100 matches a month that is about 50 MB a month of raw JSON; Postgres `jsonb`
with its indexes takes somewhat more.

### From version 1

Each v1 line maps to one v2 type (`launch` → `ball.launch`, `jev` →
`jev.call` plus `jev.answer`, and so on). A one-off import reads the v1 files,
makes one session per match, and uses the line number as `seq`.

## Writing events

- The browser queues events and POSTs them to `/api/events` every 5 s, as
  NDJSON, one request at a time.
- A write that fails is sent again with backoff (1 s, 2 s, 4 s … up to 60 s),
  with a 10 s timeout on each try, so a request that never settles can't hold
  up the rest.
- Only the closing write goes by `sendBeacon`, since Chrome's 64 KiB budget
  counts over the page's life.
- The server inserts with `on conflict (app, session, seq) do nothing`, so a
  retry that already landed changes nothing.
- The limits PR #5 set stay: bytes per write, per session and in total, and a
  session id dated near the server's clock.

## Where it is stored

Prices read 26 September 2026 from each vendor's own pricing page.

| Option | Monthly cost at 50–100 MB a month | Catch | Source |
| --- | --- | --- | --- |
| **Render Postgres, Basic-256mb** | **$6**, 1 GB included, $0.30 per GB after | Paid from day one. Point-in-time recovery 3 days on a Hobby workspace. Free Postgres expires after 30 days. | render.com/pricing, render.com/docs/free |
| Neon (hosted Postgres) | $0 on Free; Launch plan bills $0.35 per GB-month and $0.106 per compute-hour, about $1–2 here (our estimate) | Free caps storage at 0.5 GB per project, full in 5 to 10 months; compute sleeps after 5 minutes idle. | neon.com/pricing |
| Supabase (hosted Postgres) | $0 on Free; Pro $25 | Free caps the database at 500 MB and pauses a project after a week idle. | supabase.com/pricing |
| Turso (SQLite over HTTP) | $0 on Free (5 GB); Developer $4.99 | A second SQL dialect and a vendor SDK; weaker for ad hoc analytics. | turso.tech/pricing |
| Files on a Render disk | $7.25: Starter instance $7 plus 1 GB disk $0.25 | The web service must leave the free plan. A disk turns off zero-downtime deploys. Files answer no query; every chart reads every file. | render.com/pricing, render.com/docs/disks |

**Recommendation: Render Postgres Basic-256mb, $6 a month.** It lives in the
dashboard that already runs the game, the web service stays on the free plan,
1 GB holds well over a year at this rate, and it is plain Postgres, so every
query and export tool works. One database can hold several apps' events (the
`app` column), so the $6 buys the shared store too.

If paying before there are players is premature, start on **Neon Free** with
the same schema and move by `pg_dump` when it nears 0.5 GB, about ten months
in at this rate. Don't use Render's
free Postgres: it is deleted after 30 days.

### Tables

```sql
create table sessions (
  app         text not null,
  session     text not null,
  device_id   text,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  device      jsonb,
  debug       boolean not null default false,
  build       text,
  primary key (app, session)
);

create table events (
  app          text not null,
  session      text not null,
  seq          integer not null,
  v            smallint not null,
  type         text not null,
  match        text,
  ms           integer not null,
  received_at  timestamptz not null default now(),
  data         jsonb not null,
  primary key (app, session, seq)
);
create index events_type_time on events (app, type, received_at);
create index events_match on events (app, match) where match is not null;
```

`sessions` is kept up to date from `session.start` and `session.end` as they
arrive, so the backstage lists sessions without scanning events.

## The backstage and its door

Today's door is HTTP Basic with one secret, checked on the server with a
constant-time compare. Four honest options:

| Option | Work | Good | Bad |
| --- | --- | --- | --- |
| **A. HTTP Basic, one secret** (built) | Done | No dependency; the CLI uses the same secret. | No logout, no lockout, one shared password. |
| **B. Login form and a signed cookie** | About 2 h | Logout, expiry, a failure throttle; the secret still never reaches the client. | Cookie code to own: `HttpOnly`, `Secure`, `SameSite=Strict`, HMAC. |
| C. GitHub sign-in, one allowed login | About 3 h plus an OAuth app | No password to keep; easy to add a second person. | Callback URLs per host; one more outside service. |
| D. Accounts and roles | Days | Several admins with different rights. | Far more than one person needs. |

`dread-majesty-backstage` (read 26 September, not changed) is Laravel with
Filament: an email and password login at `/admin/login`, sessions in the
database for 120 minutes. Every row in `users` gets in, since
`canAccessPanel()` returns `true` (`app/Models/User.php:43-46`), and login
attempts aren't throttled (`config/auth.php:28`). It is option D's machinery
used as option B, and its stack (PHP) shares no code with this one.

**Recommendation:** keep A, and add a throttle on failed attempts (say 10 a
minute per address, held in memory, never written). Move to B when the
backstage gains anything that writes or deletes; move to C if a second person
needs in or the shared collector below is built.

## What Matthew sees first

Four questions, each one page in the backstage and one SQL query:

1. **How often does Jev aim?** Share of target catches by choice (`aim`,
   `landing`, the two angles), per match and per level, live Jev apart from
   the stand-in, by `build`, so a prompt change shows as a step.
2. **Where do players lose balls?** A histogram of `ball.lost.x` per level,
   and seconds into the level, you against Jev.
3. **How long do sessions last, and where do people stop?** Median and 90th
   percentile session length (visible time only), matches per session, and
   the level where `input.quit` or `match.end` `left` happens.
4. **How fast does Jev answer, and what does a late answer cost?** Median and
   90th percentile `clientMs` and `upstreamMs`, the share `stale` or
   `timeout`, and how often `jev.result.ballLost` follows a late answer
   compared with an on-time one.

Example, question 1:

```sql
select data->>'choice' as choice, count(*),
       round(100.0 * count(*) / sum(count(*)) over (), 1) as percent
from events e
join sessions s using (app, session)
where e.app = 'brick-arena' and e.type = 'jev.answer' and not s.debug
  and e.data->>'question' = 'target'
  and e.data->>'outcome' in ('answered', 'stale')
group by 1 order by 2 desc;
```

## Getting the raw data out

- `GET /api/admin/export?app=brick-arena&from=2026-10-01&to=2026-11-01`,
  behind the same door, streams NDJSON: one event a line, the v2 envelope
  plus `received_at`.
- `pnpm export --from <url> --since 2026-10-01 > events.ndjson` wraps it.
- NDJSON is the long-term format. DuckDB reads it straight
  (`select * from read_json_auto('events.ndjson')`), as do pandas and Postgres
  `copy`.
- `pg_dump` from Render for whole-database backups, monthly, kept off Render.

## Privacy

Don't collect:

- IP addresses. The Jev cap uses them in memory per UTC day; they are never
  written to the store or a log line with game data.
- The full user agent. Browser and OS family with the major version only.
- Names, emails, accounts, free text, or anything a player types.
- Fingerprints: no canvas, font or audio probing. No third-party analytics
  script.

Do:

- Keep `deviceId` random, in `localStorage`, linked to nothing. It still may
  count as personal data in the EU and UK, so treat it as such.
- Say so on the title screen in one line (*"This game records how each match
  plays and a random id for this browser, never who you are."*) with a link to
  a short page that repeats this list.
- Keep raw events 12 months, then delete them nightly. Keep debug and stand-in
  sessions 30 days. Summaries built from them may stay.
- Delete a device's events on request, by the id the privacy page shows.

## A shared layer for other apps

None of Matthew's apps has this, and `dread-majesty-backstage` is PHP, so the
shared part must be a contract first and code second.

Shared:

- The **envelope** (`v`, `app`, `session`, `seq`, `type`, `ms`, `build`,
  `data`) and the two **tables**, keyed by `app`.
- The **ingest contract**: `POST /api/events`, NDJSON, idempotent on
  `(app, session, seq)`, with the same size limits.
- The **door** (A now, C later) and the **export** endpoint and its NDJSON.
- The **retention** job and the **privacy** rules above.

Per app: the event types and their `data`, and the backstage's question pages.

Two ways to share it (decision 5): a small **collector** service on Render
that every app posts to (one database, one backstage, CORS allowing each app's
origin), or a **library** each app embeds (a TypeScript package here, a PHP
port for Laravel apps) writing to the one database. The collector is less code
across two languages; the library has no extra service to keep up.

## Build plan

Each row is under three hours.

| # | Work | Hours |
| --- | --- | --- |
| 1 | Envelope v2 types and validator (`packages/server/src/events.ts`) with tests; v1 → v2 mapping. | 2 |
| 2 | Browser `EventLog`: session id, device id, `seq`, retries with backoff and timeout, beacon at close. Replaces `MatchLog`. | 2.5 |
| 3 | Postgres store: schema file, insert on conflict, `DATABASE_URL`; NDJSON files when unset, for dev and tests. | 2.5 |
| 4 | Player events: `session.*`, `title.shown`, `input.*` edges, visibility. | 2 |
| 5 | Jev events: `jev.call`/`jev.answer` split, `jev.result`, proxy timing header and `proxy.call` rows. | 2.5 |
| 6 | Door: failure throttle on option A (or option B, if chosen). | 1–2 |
| 7 | Backstage pages for questions 1 and 2. | 2.5 |
| 8 | Backstage pages for questions 3 and 4. | 2.5 |
| 9 | Export endpoint and `pnpm export`. | 1.5 |
| 10 | Retention job, privacy line on the title screen, privacy page. | 1.5 |
| 11 | Import the v1 match files. | 1 |
| 12 | Matthew's step: create the database on Render, set `DATABASE_URL` and `ADMIN_SECRET`. | 0.5 |

## Decisions only Matthew can make

1. **Storage:** Render Postgres Basic-256mb at $6 a month now, or Neon Free
   until it nears 0.5 GB, then move?
2. **Device id:** may the game keep a random id per browser to count returning
   players? It reverses CLAUDE.md's *"never add who played it"*.
3. **Door:** keep HTTP Basic with a throttle, or build the login form (B) or
   GitHub sign-in (C) now?
4. **Retention:** 12 months of raw events and 30 days of debug play, or other
   lengths?
5. **Shared layer:** one collector service for all apps, or a library each app
   embeds?
6. **Notice:** the title-screen line as written, and should players get an
   opt-out?
7. **Stand-in data:** store debug and stand-in sessions (flagged, 30 days) or
   drop them at the door?
8. **Backstage host:** stay at `/matches.html` on the game's own host, or move
   to its own address (needed if the collector serves several apps)?
