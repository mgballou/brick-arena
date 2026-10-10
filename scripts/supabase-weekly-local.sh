#!/bin/bash
set -u

script_dir=$(/usr/bin/dirname "$0")
repo_root=$(/usr/bin/dirname "$script_dir")
env_file="${HOME}/.config/brick-arena/supabase.env"
timestamp=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')

if [ ! -f "$env_file" ]; then
  printf '[%s] ERROR: Supabase env file not found: %s\n' "$timestamp" "$env_file" >&2
  exit 1
fi

set -a
. "$env_file"
set +a

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SECRET_KEY:-}" ]; then
  printf '[%s] ERROR: SUPABASE_URL and SUPABASE_SECRET_KEY are required in %s\n' "$timestamp" "$env_file" >&2
  exit 1
fi

summary=""
for step in check awake prune; do
  if output=$(pnpm --dir "$repo_root" weekly "$step" 2>&1); then
    result=ok
  else
    status=$?
    output=$(printf '%s' "$output" | /usr/bin/tr '\n' ' ' | /usr/bin/sed 's/[[:space:]][[:space:]]*/ /g')
    printf '[%s] ERROR: weekly %s failed (exit %s): %s\n' "$timestamp" "$step" "$status" "$output" >&2
    exit "$status"
  fi

  output=$(printf '%s' "$output" | /usr/bin/tr '\n' ' ' | /usr/bin/sed 's/[[:space:]][[:space:]]*/ /g')
  summary="${summary:+$summary; }$step=$result${output:+: $output}"
done

printf '[%s] %s\n' "$timestamp" "$summary"
