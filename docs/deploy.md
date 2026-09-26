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
- This branch merged to `main`. `render.yaml` deploys `main`.

## Steps

1. **Account.** Sign up at <https://dashboard.render.com> with GitHub, and
   let Render read the `brick-arena` repo.
2. **Blueprint.** In the dashboard choose **New → Blueprint**, pick
   `brick-arena`, and keep branch `main`. Render reads `render.yaml` and lists
   one service, `brick-arena`, on the free plan.
3. **Secret.** Render asks for `JEV_API_KEY`, the one value marked
   `sync: false`. Paste the TypeSafe key. It goes nowhere else: not the repo,
   not the page, not a log.
4. **Deploy.** Choose **Apply**. Render runs the build
   (`npx pnpm@11 install --frozen-lockfile && npx pnpm@11 build`) and then
   `node packages/server/src/serve.ts`.
5. **Check.** Open the service URL (`https://brick-arena.onrender.com`, or
   the name Render gives it). The title screen should say *Jev is online*.
   `/healthz` answers `ok` without calling Jev.

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
  `NODE_ENV` is `production` during the build, so the build command pins pnpm 11
  and keeps devDependencies itself.

## Trying the hosted build locally

Never with the real key. A dummy key and the stand-in show the down page,
since the hosted server has no debug mode:

```sh
pnpm build
pnpm jev:stub &
JEV_API_KEY=dummy JEV_BASE_URL=http://127.0.0.1:18787 PORT=8080 pnpm start
```
