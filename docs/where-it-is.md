# Where brick arena is

The game is one match against Jev: a title screen, levels 1 to 5 with a
banner between them, a 90-second clock and three balls a side, a result after
each level and a final score. You play on the arrow keys. There is no bot mode
and no key field.

## Play it

```sh
pnpm dev
```

Run it from the repo root, open http://localhost:5173/ and press Enter.
Start checks the link to Jev first. No live Jev means no match: when Jev can't
answer, the forwarder sends 503 and the page shows *The game is down right
now* with no board, and the reason goes to the server log only. The title
screen names a reason only when the game server itself fails to answer. A
stand-in answering counts as no Jev unless the server started with
`VITE_DEBUG=1`, and then a `DEBUG · stand-in` banner stays on screen
(`docs/screens/2026-09-24/no-jev-*.png`, `debug-*.png`). Mid-match, a `down`
reply ends the match on the down page, and a bad answer is skipped. Losing the
game server, or `MISSED_AFTER` timeouts in a row (`main.tsx`), pauses the
match until Retry finds Jev again.

## The key

The dev server reads the TypeSafe key from `~/.jev-key` once, when it starts,
and adds it to each call it forwards to `https://api.typesafe.ai/v1/systemone`
with model `jev-latest`. The browser reaches Jev only through `/api/jev`.

A live call on 22 September confirmed the endpoint and model: HTTP 200 in
728 ms, choice `landing` (`8089bb9`). To check the link again:

```sh
pnpm smoke
```

It prints the status, the latency and Jev's choice. If TypeSafe wants another
root or model, put `JEV_BASE_URL=` or `JEV_MODEL=` lines in `~/.jev-key` and
restart `pnpm dev`.

## Played against a stand-in

This run predates debug mode; today it would need `VITE_DEBUG=1`.
The full five levels ran through Playwright on 24 September against
`pnpm jev:stub`, a local stand-in that then always picked `landing`, after
250 to 550 ms. It plays `clearFast` now (`packages/jev/src/stand-in.ts`). They did not run against live Jev. The stand-in took three levels and
a scripted human took two, but the human won on total, 7,110 to 5,885. Nobody
cleared a level inside the clock:

| Level | You | Stand-in | Taken by |
|---|---|---|---|
| 1 Multi-hit rows | 1,350 | 670 | you |
| 2 Split walls | 950 | 1,050 | stand-in |
| 3 Narrow gap | 110 | 200 | stand-in |
| 4 Regenerating perimeter | 1,275 | 2,860 | stand-in |
| 5 Power-up hazards | 3,425 | 1,105 | you |

It answered 602 of 604 calls (two were still out when a level ended), with a
median of 421 ms and a maximum of 674 ms, no timeouts and no failures. Answer
times are wall-clock, so a second run scores differently: an earlier one went
7,835 to 4,475. Screens are in `docs/screens/2026-09-24/`.

## What to watch

- The wide-paddle power-up drops paddle speed to 3.
- A player that always picks `landing` catches the ball dead center. The
  engine sends that straight up, so the arena sets a minimum return angle.

## A fair match at live Jev's latency

Jev used to lose balls that a player on the keys kept: it was asked about the
board on screen, and its answer landed a few hundred ms later. It is now asked
about the board as it will stand when the answer lands. Measured 24 September
with `pnpm fair`: seed 20260919, five levels of 90 s, the stand-in answering in
728 ms (the one live Jev call, 22 September), a keys player reacting in 200 ms.

| Jev board | Balls lost | Bricks | Held still |
|---|---|---|---|
| Player on the keys | 0 | 48 | |
| Before: asks about the board on screen | 15 | 24 | |
| Asks about the board ahead (kept) | 4 | 39 | |
| Holds its board until the answer lands | 2 | 30 | 300.7 of 450 s |

Answering at once, the stand-in still loses 3: those come from its own choices
(it then chased every power-up), not from latency. `clearFast` now goes
for a power-up only when it clears faster and keeps the ball. Holding the board comes closer on
the count only because Jev's board stands still two thirds of the time. It
loses balls faster per second played than asking ahead does, and it breaks
fewer bricks. So asking ahead stays.

In the browser, level 1 against `pnpm jev:stub --ms 728` (median 733 ms), Jev
lost all three balls with about 40 s left before the change and two of three
after it.
