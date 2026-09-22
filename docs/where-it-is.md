# Where brick arena is

The split-screen game runs. Two boards sit side by side on one seed and one
level: you steer the left paddle, and the right board belongs to an opponent
that answers a single multiple-choice question every 30 ticks and never touches
the paddle itself. Both boards step on the same clock, so they stay in lockstep
until the first answer differs, and then they drift.

Two opponents can hold that right board. **Bot** runs in the browser and needs
nothing — no key, no network, no server beyond the one serving the page. **Live
Jev** posts each question to `https://api.typesafe.ai/v1/systemone` with a key
you paste into the page. Without that key, or without a connection, it answers
nothing: the board keeps playing its last target and the timeout count climbs.
The page does not fall back from live to recorded, so pick Bot unless you have
the key in hand.

Not finished: the page never mounted its own React app until today, so `pnpm
dev` served a blank screen — four lines, now in. And the only Jev recording in
the repo is synthetic, written to the documented response shape rather than
captured from a real call.

## Spin it up

```sh
pnpm --dir ~/projects/brick-arena install
pnpm --dir ~/projects/brick-arena dev
```

Open http://localhost:5173/, leave the mode on **Bot (free)**, press Start.

To watch a Jev answer with no key and no network, race the synthetic recording
on the command line instead:

```sh
pnpm --dir ~/projects/brick-arena jev --replay docs/jev-calls.synthetic.ndjson
```

It finishes at tick 2284 with 76 calls, 75 applied and the one built-in
failure. For a live key and endpoint, see "Seat a real Jev" in the README.

## Controls and goal

No keys. Move the mouse across the left board and your paddle follows it; the
right paddle is not yours.

Clear the bricks before the right board does — the page scores it on which
board cleared at the earlier tick.

## Look at this first

Watch the `Last:` line under JEV STATUS change every 30 ticks. The opponent only
ever picks one of four named targets, and that constraint is the whole
experiment.
