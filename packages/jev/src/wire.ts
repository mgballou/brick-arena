import { ARENA, POINTS } from '../../engine/src/arena.ts';
import { aimShot, keepsBall, landingOf, landingX, type Ask, type BoardState, type Decision, type PowerUpKind } from '../../engine/src/index.ts';

// Wire shape of POST {baseUrl}/v1/systemone, as documented by TypeSafe and
// mirrored by Vercel AI Gateway (https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe).
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string | null> };
export type SystemOneRequest = { model: string; state: unknown; questions: { decision: ChoiceQuestion } };
// Only `type` and `choice` are documented for a Choice answer; any per-option
// probabilities are kept in the recording as received, never read here.
export type ChoiceAnswer = { type: 'choice'; choice: string; [field: string]: unknown };
export type SystemOneResponse = { model?: string; answers: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number }; answered_by?: string };

// Who answered a call. The stand-in names itself in every reply it sends;
// TypeSafe's documented reply has no `answered_by`, so a reply without the mark
// came from live Jev. Read it from the reply, never from the URL it came from.
export type AnsweredBy = 'live' | 'stand-in';
export const STAND_IN_MARK = { answered_by: 'stand-in' } as const;

export function answeredBy(response: { answered_by?: unknown }): AnsweredBy {
  return response.answered_by === STAND_IN_MARK.answered_by ? 'stand-in' : 'live';
}

// No live Jev, no game. The stand-in may play only in debug mode (VITE_DEBUG=1
// when the dev server starts). The proxy and the browser both ask this, so
// neither lets a stand-in answer pass for Jev. Null means the answer may play.
export function refusal(by: AnsweredBy, debug: boolean): string | null {
  if (by === 'live' || debug) return null;
  return 'A stand-in answered, not Jev. It plays only in debug mode: start the dev server with VITE_DEBUG=1.';
}

// The route the browser calls, same origin, on the dev server and the hosted
// one alike. Everything the key touches stays behind it.
export const JEV_PATH = '/api/jev';

// When Jev can't answer, the forwarder says so with one status and one of
// these, and the browser shows the down page in place of the board.
// `unreachable`: TypeSafe refused (auth, credits, rate) or failed or timed out.
// `used-up`: the day's cap on Jev calls is spent. The upstream detail stays in
// the server log.
export const DOWN_STATUS = 503;
export type Down = 'unreachable' | 'used-up';
export type DownReply = { ok: false; down: Down; answeredBy?: AnsweredBy };

export function downOf(status: number, body: unknown): Down | null {
  if (status !== DOWN_STATUS || typeof body !== 'object' || body === null) return null;
  const down = (body as { down?: unknown }).down;
  return down === 'unreachable' || down === 'used-up' ? down : null;
}

// The four `target` options, in the order targetOptions builds them.
export const targetKeys = ['landing', 'aim', 'angle-left', 'angle-right'] as const;

// Each ball says where and in how many ticks it comes down to the paddle's
// line, and each power-up whether the paddle can go for it and still get under
// the ball, so a ball about to be lost is plain in the state.
function boardForJev(state: BoardState) {
  return {
    tick: state.tick,
    width: state.width,
    height: state.height,
    paddle: { x: state.paddleX, width: state.paddleWidth, targetX: state.paddleTargetX, speed: state.paddleSpeed, magnet: state.magnetPaddle },
    balls: state.balls.map(ball => {
      const { id, x, y, vx, vy, tracked, piercing } = ball, landing = landingOf(state, ball);
      return { id, x, y, vx, vy, tracked, piercing, landsAt: landing && { x: landing.x, inTicks: landing.ticks } };
    }),
    powerUps: state.powerUps.map(power => ({ id: power.id, kind: power.kind, x: power.x, y: power.y, vy: power.vy, keepsBall: keepsBall(state, power) })),
    bricks: state.bricks.filter(brick => brick.unbreakable || brick.durability > 0).map(({ x, y, durability, unbreakable, regenerates }) => ({ x, y, durability, unbreakable, regenerates })),
    livesLost: state.livesLost,
  };
}

const trackedBall = (state: BoardState) => state.balls.find(item => item.tracked) ?? state.balls[0];

function criteriaFor(ask: Ask): Record<string, string> {
  const { state, options } = ask;
  if (ask.question === 'target') {
    if (options.length !== targetKeys.length) throw new Error(`target ask has ${options.length} options, expected ${targetKeys.length}`);
    const [landing, aim, left, right] = options.map(Number);
    const ball = trackedBall(state);
    const shot = aimShot(state, ball, landingX(state, ball));
    return {
      landing: `Catch the ball dead center where it comes down, x=${landing.toFixed(1)}: the safest catch, sending it back up almost straight`,
      aim: shot
        ? `Catch it at x=${aim.toFixed(1)} to send it into the densest bricks it can reach: the column at x=${shot.x}, ${shot.hitPoints} hit points open from below`
        : `No return reaches a breakable brick: catch it dead center at x=${aim.toFixed(1)}`,
      'angle-left': `Catch it on the paddle's right side at x=${left.toFixed(1)} to send it up and to the left at 45 degrees`,
      'angle-right': `Catch it on the paddle's left side at x=${right.toFixed(1)} to send it up and to the right at 45 degrees`,
    };
  }
  if (ask.question === 'chase') {
    return Object.fromEntries(options.map(option => {
      const id = String(option);
      if (id === 'none') return [id, `Leave the power-ups and play the ball: catch it dead center where it comes down, x=${landingX(state, trackedBall(state)).toFixed(1)}`];
      const power = state.powerUps.find(item => item.id === id);
      if (!power) return [id, `Catch power-up ${id}`];
      const cost = keepsBall(state, power) ? 'the paddle can still get back under the ball' : 'the ball comes down out of reach first, so going for it loses the ball';
      return [id, `Catch the falling ${power.kind} power-up at x=${power.x.toFixed(1)}, y=${power.y.toFixed(1)}: ${POWER_UP_EFFECTS[power.kind]}; ${cost}`];
    }));
  }
  return Object.fromEntries(options.map(option => {
    const id = String(option);
    const ball = state.balls.find(item => item.id === id);
    return [id, ball ? `Follow ${id} at x=${ball.x.toFixed(1)}, y=${ball.y.toFixed(1)}, moving ${ball.vy > 0 ? 'down' : 'up'}` : `Follow ${id}`];
  }));
}

// What each power-up does to the pace of a clear, for the chase question.
const POWER_UP_EFFECTS: Record<PowerUpKind, string> = {
  'extra-ball': 'a second ball breaks bricks alongside the first',
  'piercing-ball': 'balls pass through breakable bricks, damaging each',
  'long-slow-paddle': 'a wider paddle that moves slower',
  'magnet-paddle': 'returns leave the paddle steeper, so aiming sideways is harder',
  'short-paddle': 'a narrower paddle, so more balls are missed',
};

// The objective and the scoring, as docs/scoring.md defines them. Every
// question opens with it, so each answer is aimed at winning the level.
export const OBJECTIVE = [
  'You play a level of breakout against a human on an identical board.',
  'Performance is clearing fast: the first to break every breakable brick wins the level, and that ends it.',
  `If nobody clears in ${ARENA.levelSeconds} seconds, the larger share of the level's brick hit points broken wins.`,
  `Score: ${POINTS.percentCleared} per percent of hit points broken, plus ${POINTS.secondLeft} per second left on the clock when you clear.`,
  `A lost ball scores nothing and costs no points, but it costs the serve and the trip back up to the bricks, and losing the last of your ${ARENA.lives} ends your level where it stands, with every brick left unbroken.`,
  'So keep the ball first: never choose an option that lets a ball past the paddle, for bricks or for a power-up. Among the options that keep the ball, choose whatever breaks bricks soonest.',
].join(' ');

const questions: Record<Ask['question'], string> = {
  target: 'Where should the paddle catch the ball, and so where does the ball go next?',
  chase: 'A power-up is falling. Which one should the paddle go for, if any, or should it stay with the ball?',
  track: 'Several balls are in play. Which ball should the paddle play?',
};

const instructions = (question: Ask['question']) => `${OBJECTIVE} ${questions[question]}`;

export function toRequest(ask: Ask, model: string): SystemOneRequest {
  return { model, state: boardForJev(ask.state), questions: { decision: { type: 'choice', instructions: instructions(ask.question), criteria: criteriaFor(ask) } } };
}

export function fromResponse(ask: Ask, response: SystemOneResponse): Decision {
  const answer = response.answers?.decision as Partial<ChoiceAnswer> | undefined;
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string') throw new Error(`Jev answer is not a choice: ${JSON.stringify(answer)}`);
  const keys = Object.keys(criteriaFor(ask));
  if (!keys.includes(answer.choice)) throw new Error(`Jev chose "${answer.choice}", outside the offered set ${JSON.stringify(keys)}`);
  if (ask.question === 'target') return { kind: 'target', x: Number(ask.options[targetKeys.indexOf(answer.choice as typeof targetKeys[number])]) };
  // Leaving the power-ups means playing the ball, so the paddle goes under it.
  if (ask.question === 'chase' && answer.choice === 'none') return { kind: 'target', x: landingX(ask.state, trackedBall(ask.state)) };
  if (ask.question === 'chase') return { kind: 'chase', powerUpId: answer.choice };
  return { kind: 'track', ballId: answer.choice };
}
