-- The match record as rows (docs/specs/data-collection.md). The game server is
-- the only writer, with the secret key (packages/server/src/rows.ts). Row-level
-- security is on for every table with no policies, so the publishable key can
-- read and write nothing.

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

alter table matches enable row level security;
alter table jev_calls enable row level security;
alter table match_events enable row level security;
alter table level_progress enable row level security;
