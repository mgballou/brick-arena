# Ball against bricks

Fixed 24 September in `e17ff26`, after his report at 9:29 PM: *"there is a
collision issue with the unbreakable bricks. i think."*

## What was wrong

`step` treated a brick as touched whenever the ball's box overlapped it, then
flipped `vy`, whichever face the ball met. It never moved the ball out, and it
stopped at the first brick it touched each tick. A breakable brick usually broke
and hid the fault. An unbreakable one stayed, so a ball that met its side kept
flipping `vy` each tick while it slid through the brick.

`857d961` pins six cases in `packages/engine/src/collision.test.ts`. Each failed
on the old engine:

| Case | Old engine |
|---|---|
| Side hit on an unbreakable brick | ball ends inside the wall |
| Corner: breakable brick above, unbreakable beside | ball ends inside the unbreakable brick |
| Ball at `vy` -50 against an unbreakable row | passes straight through |
| Head-on top hit (the control) | bounces the right way, but sits 1.8 px inside on the hit tick |
| Ball starting inside an unbreakable brick | stays inside |
| Ball rising into the seam between two bricks | ends inside a brick |

## What `step` does now

Each ball's path is swept against every solid brick, grown by the ball's
radius. At the closest hit the ball stops on that face, reflects on its axis,
and carries on with the rest of the move, up to eight bounces a tick. A path that
enters both slabs at once has hit a corner and turns both ways. A ball that
starts a tick inside a brick leaves by the shortest way out. Unbreakable bricks
now stop a piercing ball, which used to pass through them.

From [jakesgordon/javascript-breakout](https://github.com/jakesgordon/javascript-breakout)
(`game.js` `ballIntercept`, `breakout.js` `Ball.update`, read 24 September) I
took the swept test against a rectangle grown by the radius, the closest hit
across all bricks, and carrying the rest of the move on after a bounce. I did not
take its side-first rule: it tests the side faces and turns to top and bottom
only if they miss, so it can report a side hit when the path crossed the bottom
first. Here the slab the path enters last names the face.

## Replayed before and after

I stepped every tick of all ten saved games in `docs/session.ndjson` (about
100,000 ticks) through both engines from the same state. The engines differ on
36 to 203 ticks a game, and on none where no ball touched a brick. The fix
changes collisions and nothing else.

The outcomes still change. On level 0 the bot catches the ball dead center at
tick 811, and from then on `vx` is 0: the ball runs straight up and down one
column forever. The old engine cleared level 0 only because a wrong flip at tick
77 sent the ball another way. On the new engine neither the bot nor the scripted
Human clears level 0 on seed 20260919. On 24 September the Human cleared level
1 at tick 3348; since 26 September it catches where the ball really lands
(`landingOf`), falls into the same loop, and clears no level (`CLAUDE.md`).

So:

- `docs/session.ndjson` was regenerated. The replay test replays the Human's
  level 0 (`replay.test.ts`), which checks the state sequence whether or not the
  level clears.
- The synthetic Jev recording moved to seed 20260962, level 1, that day. Since
  its rule became `aim` it plays seed 20260919, level 0 again (`SYNTHETIC` in
  `packages/jev/src/synthetic.ts`, and the README).
- The paddle-width note in `CLAUDE.md` is corrected: with the fix, neither 180
  nor 120 clears a level.

## Left for him

- `step` has no floor on the return angle. The arena has one (`minReturnVx`), so
  the web game does not fall into the column loop, but `pnpm session` and
  `pnpm jev` do. Adding the floor to `step` would change the paddle, not a
  collision, so I left it out.
- The `pnpm fair` table in `README.md` was measured on the old
  engine. I have not measured it again.
- CI shows one red run, on `857d961`. The tests there fail on purpose, and a
  bad shell expansion pushed that commit about a minute before the fix.
  `e17ff26` is green.
