# Where brick arena is

The game is one match against Jev: a title screen, levels 1 to 5 with a
banner between them, a 90-second clock and three balls a side, a result after
each level and a final score. You play on the arrow keys. There is no bot mode
and no key field.

## Play it

```sh
pnpm --dir ~/projects/brick-arena dev
```

Open http://localhost:5173/ and press Enter. The title screen checks the link
to Jev before Start lights up.

## The key

The dev server reads the TypeSafe key from `~/.jev-key` once, when it starts,
and adds it to each call it forwards to `https://api.typesafe.ai/v1/systemone`
with model `jev-latest`. The browser only ever calls `/api/jev`.

**Not yet confirmed against live Jev.** The permission guard refused the one
real call made on 24 September, and a web search of TypeSafe's docs, so the
endpoint and model come from the earlier web client. One command settles it:

```sh
pnpm --dir ~/projects/brick-arena smoke
```

It prints the status, the latency and Jev's choice. If TypeSafe wants another
root or model, put `JEV_BASE_URL=` or `JEV_MODEL=` lines in `~/.jev-key` and
restart `pnpm dev`.

## Played against a stand-in

The full five levels ran through Playwright on 24 September against
`pnpm jev:stub`, a local stand-in that always picks `landing` after 250 to
550 ms. They did not run against live Jev. A scripted human won 7,835 to 4,475:

| Level | You | Stand-in | Taken by |
|---|---|---|---|
| 1 Multi-hit rows | 1,450 | 600 | you, on score |
| 2 Split walls | 1,075 | 500 | you, on score |
| 3 Narrow gap | 150 | 1,405 | stand-in, cleared with 61 s left |
| 4 Regenerating perimeter | 1,735 | 330 | you, on score |
| 5 Power-up hazards | 3,425 | 1,640 | you, on score |

It answered 339 of 340 calls (the last was still out when the level ended),
with a median of 423 ms and a maximum of 753 ms, no timeouts and no failures.
Screens are in `docs/screens/2026-09-24/`.

## What to watch

- Jev loses balls that a player on the keys keeps. Its answer lands a few
  hundred ms after the ask while the board moves on, and the wide-paddle
  power-up drops paddle speed to 3.
- A player that always picks `landing` catches the ball dead center. The
  engine sends that straight up, so the arena sets a minimum return angle.
