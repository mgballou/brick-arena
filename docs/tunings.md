# Two tunings for the level clear time

Nobody cleared a level inside the 90 s clock on 24 September. Two tunings
sit behind a query flag so you can play each and pick. The standard game stays
the default, and `step`, `createBoard` and the recorded fixtures are unchanged.
The fun is your call; the numbers below only say what each tuning does to clear
times.

## Play them

Against live Jev (`~/.jev-key`, as in the README):

```sh
pnpm dev
# http://localhost:5173/?tuning=angled
# http://localhost:5173/?tuning=one-hit
# http://localhost:5173/            the standard game, for comparison
```

Against the stand-in, with no key and no Jev call:

```sh
pnpm jev:stub
VITE_DEBUG=1 JEV_KEY_FILE=<a file holding any token> JEV_BASE_URL=http://127.0.0.1:18787 pnpm dev
# then the same three URLs
```

A tuned game shows `TUNING · angled` (or `one-hit`) in the top banner, and
`window.__arena.read().tuning` names it. Any other `?tuning=` plays standard.

## What each one changes

`TUNINGS` in `packages/engine/src/arena.ts` holds all three.

| | standard | angled | one-hit |
|---|---|---|---|
| Paddle width | 120 | 130 | 120 |
| Paddle speed under the wide paddle power-up | 3 | 7 | 7 |
| Slowest sideways return off the paddle | 1.1 | 1.6 | 1.1 |
| Hit points per breakable brick | 1 to 3 | 1 to 3 | 1 |

- **angled**: every catch leaves the paddle at an angle, so a ball caught
  dead center stops going straight up and down one column. The level stays as
  hard as it was; the ball covers more of it.
- **one-hit**: every breakable brick breaks on its first hit. Regenerating
  bricks on level 4 then have nothing to win back. Unbreakable bricks stay.

Both keep the paddle at speed 7 after the wide paddle power-up, which drops it
to 3 in the standard game.

## Clear times

Measured 25 September with `pnpm tunings`: seeds 20260919 to 20260923, every
level played alone on its board for the full 90 s, or until it clears or runs
out of balls.

- **jev** is the stand-in as the game plays it, asking about the board as it
  will stand when its answer lands. It runs at 500, 728 and 1000 ms answers,
  so 15 runs a level.
- **aim** is the stand-in's rule answering in 200 ms: a player who aims every
  catch at the densest bricks. 5 runs a level.
- **keys** is a player on the arrow keys who sees the board 200 ms late and
  only catches, never aims. 5 runs a level.

Seeds change only which power-ups fall, so runs on one player vary little.
Each cell is levels cleared out of runs, then the median clear time, or the
median share cleared when none clears.

| Level | Player | standard | angled | one-hit |
|---|---|---|---|---|
| 1 multi-hit rows | jev | 15/15, 57.9 s | 15/15, 72.5 s | 10/15, 62.1 s |
| | aim | 0/5 (96%) | **5/5, 71.0 s** | **5/5, 47.8 s** |
| | keys | 0/5 (70%) | 0/5 (93%) | **5/5, 75.2 s** |
| 2 split walls | jev | 0/15 (81%) | **5/15, 75.5 s** | 0/15 (81%) |
| | aim | 0/5 (81%) | 0/5 (68%) | 0/5 (81%) |
| | keys | 0/5 (81%) | 0/5 (18%) | 0/5 (81%) |
| 3 narrow gap | jev | 5/15, 56.5 s | **10/15, 76.6 s** | 5/15, 86.2 s |
| | aim | 0/5 (50%) | 0/5 (75%) | 0/5 (50%) |
| | keys | 0/5 (8%) | 0/5 (50%) | 0/5 (12%) |
| 4 regenerating perimeter | jev | 0/15 (46%) | 0/15 (68%) | **5/15, 63.7 s** |
| | aim | 0/5 (41%) | 0/5 (50%) | **5/5, 63.7 s** |
| | keys | 0/5 (56%) | 0/5 (38%) | 0/5 (85%) |
| 5 power-up hazards | jev | 12/15, 45.9 s | 11/15, 45.3 s | 5/15, 39.1 s |
| | aim | 3/5, 44.9 s | 5/5, 50.6 s | 5/5, 58.3 s |
| | keys | 0/5 (93%) | 0/5 (57%) | **5/5, 68.4 s** |

Totals, levels cleared out of 125 runs, and balls lost:

| | standard | angled | one-hit |
|---|---|---|---|
| jev | 32/75, 101 lost | 41/75, 132 lost | 25/75, 145 lost |
| aim | 3/25, 44 lost | 10/25, 15 lost | 15/25, 30 lost |
| keys | 0/25, 0 lost | 0/25, 0 lost | 10/25, 0 lost |
| **all** | **35** | **51** | **50** |

What the numbers say:

- **angled** helps the aiming players most: Jev clears 41 levels to 32 and
  reaches level 2 at all, and the aiming player loses a third as many balls.
  Its clears come later, about 72 to 77 s against 57 s, because a slanted
  ball takes longer to reach the last bricks. A player who only catches
  gains nothing.
- **one-hit** is the only tuning a player who only catches can clear: levels
  1 and 5. It is also the only one that clears level 4. Jev clears fewer
  levels than standard (25 to 32) and loses more balls. With one hit a brick
  the board thins fast and the stand-in chases more power-ups.
- **No tuning clears level 2 for an aiming player or level 3 for a player.**
  The last three or four bricks there sit in pockets between unbreakable
  bricks, and finding them is luck. A fix belongs in the level table in
  `createBoard`, which means regenerating the recorded fixtures. That is a
  separate change.
- The stand-in's lost balls came mostly from chasing power-ups, as
  `pnpm fair` found on 24 September. No tuning touches that rule. Since
  26 September `clearFast` (`packages/jev/src/stand-in.ts`) goes for a
  power-up only when the paddle can still get back under the ball, so these
  counts predate that change (`docs/scoring.md`, *Keeping the ball*).

To re-measure one tuning: `pnpm tunings --tuning angled`. Other flags:
`--seeds 3`, `--ms 728`, `--react 250`. A full run of all three takes about 95 s.

## Tried and dropped

Swept on 25 September over two seeds, in the same harness:

- **A faster board** (`step` at `dt` 1.25 and 1.5 a frame). Jev's answer lands
  after the ball does. At 1.5× and 728 ms the stand-in lost every ball on every
  level; at 1.25× it lost 98 balls in 45 runs against 62 at standard, and
  cleared 9 levels against 18. It would make the match unfair to Jev.
- **A faster paddle** (10 for 7). Jev cleared 10 of 30 either way.
- **Slower regeneration** (240 or 300 ticks for 90, or none) on its own. Level
  4 stayed uncleared; lost balls ended those runs first.
- **A 2 hit point cap.** Against the same tuning without it, it changed only
  levels 4 and 5, and cleared fewer.
- **A 2.2 sideways floor.** Jev cleared 6 of 30, against 14 at 1.6.
