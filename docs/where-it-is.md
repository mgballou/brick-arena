# Where Brick Arena is

Brick Arena is a browser game: you play Breakout against Jev, which chooses
from a closed list of moves. The page talks to Jev through the local dev server
or the hosted Node server; the TypeSafe key stays on the server
(`packages/web/src/main.tsx`, `packages/jev/src/proxy.ts`).

## Run it locally

You need Node 24 and a TypeSafe API key. From the repo root:

```sh
pnpm install
printf '%s\n' '<your TypeSafe key>' > ~/.jev-key
chmod 600 ~/.jev-key
pnpm dev
```

Open <http://localhost:5173>. The dev server reads `~/.jev-key` when it
starts. The title screen checks Jev before a match; if Jev is unavailable, the
game shows its down page instead of a board. `pnpm smoke` makes one live call
and prints its status, latency and choice.

## Use the local stand-in

For local play without a live Jev call, run the stand-in in one terminal:

```sh
pnpm jev:stub
```

Then start the dev server in another terminal:

```sh
printf 'dummy\n' > /tmp/dummy-key
VITE_DEBUG=1 JEV_KEY_FILE=/tmp/dummy-key JEV_BASE_URL=http://127.0.0.1:18787 pnpm dev
```

The page shows a debug banner and names the stand-in. The stand-in is allowed
only in debug mode; hosted play has no debug mode. See
`packages/jev/src/stand-in.ts` for its choices.

## Find the code

| Area | Location |
| --- | --- |
| Board rules, levels and scoring | `packages/engine/` |
| Jev prompt, key reader, proxy and stand-in | `packages/jev/` |
| Browser page and input | `packages/web/` |
| Hosted server, match files and admin routes | `packages/server/` |
| CLI tools | `packages/cli/` |
| Supabase schema and local database | `supabase/` |

The server stores each match as an NDJSON file in `MATCHES_DIR` (default
`var/matches`). Supabase row writes are optional and require
`SUPABASE_WRITES=1` plus project credentials. See
[`docs/deploy.md`](deploy.md#match-records) for storage and
[`docs/specs/data-collection.md`](specs/data-collection.md) for the collected
events.

## Useful commands

Commands are defined in the root `package.json`:

```sh
pnpm test       # unit and integration tests; no live Jev or Supabase
pnpm build      # typecheck and production browser build
pnpm e2e        # browser specs
pnpm test:db    # Supabase storage path against local Postgres/PostgREST
```

Other tools include `pnpm fair`, `pnpm objective`, `pnpm tunings`,
`pnpm match` and `pnpm export`.
