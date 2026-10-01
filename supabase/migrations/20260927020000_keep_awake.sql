-- One row a week from the weekly job (.github/workflows/supabase-weekly.yml),
-- so a Free project sees database activity even in a week with no matches and
-- is not paused. The job's prune deletes rows older than 90 days.

create table keep_awake (
  at          timestamptz primary key default now()
);

alter table keep_awake enable row level security;
