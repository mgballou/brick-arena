# Scoring

This page defines performance in a match once. The score measures it
(`POINTS`, `levelScore` and `levelWinner` in `packages/engine/src/arena.ts`),
the match screen explains it (the line under the scoreboard, and the panel
behind **How scoring works**, or H), and Jev's prompt states it and offers
choices aimed at it (`OBJECTIVE` and the `target` options in
`packages/jev/src/wire.ts`). Change one and you change them all.

## Performance is clearing fast

The win is clearing the level first, so the speed of clearing is what
performance means.

- **A level goes to the first board to break every breakable brick.** That
  clear ends the level for both boards.
- **Both boards start together.** A 3 s countdown opens each level, and both
  first balls launch the tick it ends; pressing Space early does nothing. The
  90 s clock starts then.
- **If nobody clears,** the level ends when the 90 s clock runs out, or when
  both boards are out of balls. The larger share cleared then takes it.
- **The share cleared** is the level's breakable hit points broken, as a
  percent rounded down. A two-hit brick hit once counts one of its two. A
  regenerating brick that heals counts as unbroken again. Only a clear reads
  100%.
- **A lost ball** scores nothing and costs no points. It costs time: the serve
  (Jev serves 45 ticks, 0.75 s, after the loss; you serve when you press
  Space) and the ball's trip back up to the bricks. Losing the last of three
  ends your level where it stands: your board stops, and your share cleared
  stays as it is while the other board plays on.
- **A power-up** scores nothing. It counts only through what it does to the
  pace of the clear.

## The score ranks players as the win does

A level scores **10 points per percent cleared, plus 10 points per whole
second left on the clock at the clear.**

- A clear reads 100%, so it scores at least 1,000. A board not cleared reads
  99% at most, so it scores at most 990. The first to clear always outscores
  the other board, however late the clear.
- Two boards that clear on the same frame score the same and tie.
- If nobody clears, the scores are ten times the shares cleared, so the larger
  share leads.

So `levelWinner` is the higher level score. It never disagrees with "first to
clear, else the larger share."

The match goes to the higher total over five levels. The total counts the
finished levels plus the level in play as it stands, so the score leader on
screen is the player who would win if the match stopped now. A faster clear
is worth more to the total: a clear at 60 s left scores 1,600, and one at 10 s
left scores 1,100.

Before this definition, a hit scored 10, a break 40 per hit point, a power-up
25, and a clear 500 plus 5 a second. A lost ball cost nothing, and the level
still went to the first clear. On 24 September a player lost a ball, cleared
first and won, while the running score had them behind.

## What Jev is told and offered

Every question opens with the objective and this scoring (`OBJECTIVE` in
`wire.ts`, built from `ARENA` and `POINTS`, so the numbers cannot drift). It
ends: "So keep the ball first: never choose an option that lets a ball past the
paddle, for bricks or for a power-up. Among the options that keep the ball,
choose whatever breaks bricks soonest." Keeping the ball is not a second
measure of performance. It follows from this one: the third lost ball ends your
level with every brick left standing unbroken.

The board Jev is sent shows what a choice costs. Each ball carries `landsAt`,
where and in how many ticks it comes down to the paddle's line, and each
power-up carries `keepsBall`, whether the paddle can go for it and still get
under the ball (`landingOf` and `keepsBall` in `packages/engine/src/index.ts`).

The `target` question asks where to catch the ball, and so where it goes next.
Its four options are paddle positions, built by `targetOptions` in
`packages/engine/src/index.ts`, around where the ball comes down. `landingOf`
finds that point by flying the ball tick by tick as `step` would, through the
bricks, so a rising ball has a landing point too:

- `landing`: catch it dead center. The safest catch; the ball goes back up
  almost straight.
- `aim`: catch it off center to send it into the densest bricks it can reach.
  `aimShot` tries every return speed the paddle can give, in steps of 0.1,
  and flies each one to the first brick it meets with the engine's own sweep.
  It keeps the return whose first brick sits in the column with the most hit
  points open from below. It skips returns slower than the arena's
  `minReturnVx`, since the arena would steepen those and miss.
- `angle-left`, `angle-right`: catch it so the ball leaves at 45 degrees.

`chase` says what each power-up does to the pace of a clear, and whether going
for it loses the ball. Its `none` option plays the ball: the paddle goes to
where it comes down. `track` asks which ball to play. The choice stays
categorical, one call per ask, with the same deadline.

## What the new objective did

Measured 24 September with `pnpm objective`, in debug mode's terms: no call
left the machine and live Jev was never asked. It plays the web game's Jev
board headless, in game time, asked about the board ahead as the game does now.
Two stand-in rules answer through the same wire (`toRequest`, `fromResponse`):
`landing`, the old stand-in, and `aim`, the rule in `stand-in.ts` that follows
the new prompt (`aim` every catch, go only for extra-ball and piercing-ball,
play the lowest falling ball). The two runs of one seed then meet as the two
sides of a level. 50 seeds from 20260919, five levels each, 250 levels a rule.

The brick layout is the same on every seed; the seed drops the power-ups and
draws each answer's time, the median give or take up to 150 ms. Without that
spread, most seeds play the same game.

| Answers in | Rule | Levels cleared | Balls lost | Levels won head to head |
|---|---|---|---|---|
| 728 ± 150 ms | landing | 10 of 250 | 351 | 26 |
| | aim | 78 of 250 | 461 | 214 (10 ties) |
| 421 ± 150 ms | landing | 7 of 250 | 329 | 30 |
| | aim | 91 of 250 | 436 | 215 (5 ties) |

728 ms is the one live Jev call (22 September); 421 ms is the stand-in's median
in the browser. By level, at 728 ms:

| Level | landing cleared | aim cleared | aim median clear | aim's share cleared at 90 s, mean |
|---|---|---|---|---|
| 1 Multi-hit rows | 1 | 31 | 52.6 s | 96% |
| 2 Split walls | 1 | 1 | 65.0 s | 79% |
| 3 Narrow gap | 6 | 16 | 53.0 s | 89% |
| 4 Regenerating perimeter | 0 | 0 | | 47% |
| 5 Power-up hazards | 2 | 30 | 51.5 s | 90% |

Aiming clears about eight times as many levels and takes most levels from the
old rule, while it loses about 30% more balls. That is the trade the scoring
asks for. It does not crack split walls or the regenerating perimeter. In the
browser, against `pnpm jev:stub` at a 406 ms median, the stand-in cleared level
1 with 14 s left and scored 1,140 (`docs/screens/2026-09-24/scoring-*.png`).

These are scripted rules, not Jev. The prompt now tells Jev the objective and
offers it the aimed catch; whether it takes it, and whether it beats a person
with it, only a match against live Jev shows. *Keeping the ball* has the first.

To run it again: `pnpm objective` (`--seeds`, `--ms`, `--jitter` to change).

## Keeping the ball

On 25 September Matthew played live Jev and saw it lose all three balls on one
level. Measured 26 September with `pnpm objective`, 50 seeds from 20260919, the
stand-in's `aim` rule before and after this change. No call left the machine.

Before, two things lost the balls. While a power-up fell, every question was
`chase`, and answering `none` left the paddle where it stood; going for one
dragged it off the ball. That cost 314 of the 461 balls lost at 728 ms. Most of
the rest were answers that landed too late to reach a ball that had turned off
a brick, since the landing option assumed the ball fell straight from where it
was, or, while it rose, sent the paddle to the middle. The prompt said a lost
ball "costs nothing but the time to serve again", and nothing sent showed that
a choice would lose one.

| Answers in | | Balls lost | Levels out of balls | Levels cleared | Won head to head of 250 |
|---|---|---|---|---|---|
| 728 ± 150 ms | before | 461 | 91 | 78 | 214 |
| | after | 63 | 0 | 160 | 195 |
| 421 ± 150 ms | before | 436 | 64 | 91 | 215 |
| | after | 62 | 2 | 139 | 185 |

By level, at 728 ms, before and after:

| Level | Balls lost | Out of balls, of 50 | Cleared, of 50 | Median clear |
|---|---|---|---|---|
| 1 Multi-hit rows | 67, 4 | 12, 0 | 31, 41 | 52.6 s, 70.0 s |
| 2 Split walls | 121, 14 | 27, 0 | 1, 41 | 65.0 s, 71.3 s |
| 3 Narrow gap | 69, 5 | 9, 0 | 16, 44 | 53.0 s, 77.0 s |
| 4 Regenerating perimeter | 124, 3 | 30, 0 | 0, 0 | |
| 5 Power-up hazards | 80, 37 | 13, 0 | 30, 34 | 51.5 s, 79.2 s |

Split walls and the regenerating perimeter were the worst levels, out of balls
on more than half the seeds; now neither runs out. Clears come later, since
the rule passes on power-ups it cannot reach safely, and on level 5 at 421 ms it
clears 19 seeds where it cleared 35. "Won head to head" plays each rule against
the old `landing` rule, which changed too, so that column compares less
cleanly than the others.

These are scripted rules, not Jev. The prompt now tells Jev to keep the ball
first and shows it which choices lose one; whether it does, only a match
against live Jev will show.
