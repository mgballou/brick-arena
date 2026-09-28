import { ARENA, POINTS } from '../../engine/src/arena.ts';
import { aimShot, keepsBall, landingOf, landingX, type Ask, type BoardState, type Decision, type PowerUpKind } from '../../engine/src/index.ts';

// Wire shape of POST {baseUrl}/v1/systemone, as documented by TypeSafe and
// mirrored by Vercel AI Gateway (https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe).
type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string | null> };
export type SystemOneRequest = { model: string; state: unknown; questions: { decision: ChoiceQuestion } };
// Only `type` and `choice` are documented for a Choice answer; any per-option
// probabilities are kept in the recording as received, never read here.
type ChoiceAnswer = { type: 'choice'; choice: string; [field: string]: unknown };
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

// Every option's text, with a slot for each value criteriaFor fills in. The
// proxy checks an ask's options against the same table (askRefusal), so only
// these sentences, with numbers, ids and the fixed phrases below in the slots,
// ever reach Jev.
const OPTION_TEXT = {
  landing: 'Catch the ball dead center where it comes down, x={x}: the safest catch, sending it back up almost straight',
  aim: 'Catch it at x={x} to send it into the densest bricks it can reach: the column at x={x}, {x} hit points open from below',
  aimNowhere: 'No return reaches a breakable brick: catch it dead center at x={x}',
  angleLeft: "Catch it on the paddle's right side at x={x} to send it up and to the left at 45 degrees",
  angleRight: "Catch it on the paddle's left side at x={x} to send it up and to the right at 45 degrees",
  none: 'Leave the power-ups and play the ball: catch it dead center where it comes down, x={x}',
  power: 'Catch the falling {kind} power-up at x={x}, y={x}: {effect}; {cost}',
  powerGone: 'Catch power-up {power}',
  ball: 'Follow {ball} at x={x}, y={x}, moving {way}',
  ballGone: 'Follow {ball}',
} as const;
type OptionText = keyof typeof OPTION_TEXT;

// The options each question may offer: target's four by name, and a chase or
// track option by the id of a power-up or ball in the ask's own state.
const TARGET_TEXT: Record<typeof targetKeys[number], readonly OptionText[]> = { landing: ['landing'], aim: ['aim', 'aimNowhere'], 'angle-left': ['angleLeft'], 'angle-right': ['angleRight'] };
const CHASE_TEXT: readonly OptionText[] = ['power', 'powerGone'];
const TRACK_TEXT: readonly OptionText[] = ['ball', 'ballGone'];

// Fills each slot in turn with the next value.
function optionText(text: OptionText, ...values: Array<string | number>): string {
  let next = 0;
  return OPTION_TEXT[text].replace(/\{\w+\}/g, () => String(values[next++]));
}

function criteriaFor(ask: Ask): Record<string, string> {
  const { state, options } = ask;
  if (ask.question === 'target') {
    if (options.length !== targetKeys.length) throw new Error(`target ask has ${options.length} options, expected ${targetKeys.length}`);
    const [landing, aim, left, right] = options.map(Number);
    const ball = trackedBall(state);
    const shot = aimShot(state, ball, landingX(state, ball));
    return {
      landing: optionText('landing', landing.toFixed(1)),
      aim: shot ? optionText('aim', aim.toFixed(1), shot.x, shot.hitPoints) : optionText('aimNowhere', aim.toFixed(1)),
      'angle-left': optionText('angleLeft', left.toFixed(1)),
      'angle-right': optionText('angleRight', right.toFixed(1)),
    };
  }
  if (ask.question === 'chase') {
    return Object.fromEntries(options.map(option => {
      const id = String(option);
      if (id === 'none') return [id, optionText('none', landingX(state, trackedBall(state)).toFixed(1))];
      const power = state.powerUps.find(item => item.id === id);
      if (!power) return [id, optionText('powerGone', id)];
      return [id, optionText('power', power.kind, power.x.toFixed(1), power.y.toFixed(1), POWER_UP_EFFECTS[power.kind], keepsBall(state, power) ? KEEPS_BALL.yes : KEEPS_BALL.no)];
    }));
  }
  return Object.fromEntries(options.map(option => {
    const id = String(option);
    const ball = state.balls.find(item => item.id === id);
    return [id, ball ? optionText('ball', id, ball.x.toFixed(1), ball.y.toFixed(1), ball.vy > 0 ? 'down' : 'up') : optionText('ballGone', id)];
  }));
}

const KEEPS_BALL = { yes: 'the paddle can still get back under the ball', no: 'the ball comes down out of reach first, so going for it loses the ball' } as const;

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

// The model the browser names in an ask. The proxy checks it, then sends the
// key's own model in its place.
export const ASK_MODEL = 'jev';

// The check before a match: the one ask that is not a game question.
const HEALTH_QUESTION: ChoiceQuestion = { type: 'choice', instructions: 'Reply with ready.', criteria: { ready: 'The link is up' } };
export function healthRequest(model: string): SystemOneRequest {
  return { model, state: { tick: 0 }, questions: { decision: HEALTH_QUESTION } };
}

// The whole of what may be asked of Jev on this key, as boardForJev and
// criteriaFor build it: a board of numbers, flags and the engine's ids, one
// choice question in the game's own words, and options from OPTION_TEXT. The
// key is not a general service; anything else is refused before it is sent.
type Check = (value: unknown) => boolean;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const num: Check = value => typeof value === 'number' && Number.isFinite(value);
const flag: Check = value => typeof value === 'boolean';
const matches = (pattern: RegExp): Check => value => typeof value === 'string' && pattern.test(value);
const oneOf = (values: readonly unknown[]): Check => value => values.includes(value);
const listOf = (item: Check): Check => value => Array.isArray(value) && value.every(item);
const orNull = (check: Check): Check => value => value === null || check(value);
const exactly = (fields: Record<string, Check>): Check => value => isRecord(value) && hasKeys(value, Object.keys(fields)) && Object.entries(fields).every(([key, check]) => check(value[key]));

// Ids as the engine makes them: `ball-0`, `ball-t812` (arena.ts), `power-412-brick-3-1`.
const BALL_ID = /^ball-t?\d+$/;
const POWER_ID = /^power-\d+-brick-\d+-\d+$/;
const powerUpKinds = Object.keys(POWER_UP_EFFECTS) as PowerUpKind[];

const isBoard = exactly({
  tick: num,
  width: num,
  height: num,
  paddle: exactly({ x: num, width: num, targetX: num, speed: num, magnet: flag }),
  balls: listOf(exactly({ id: matches(BALL_ID), x: num, y: num, vx: num, vy: num, tracked: flag, piercing: flag, landsAt: orNull(exactly({ x: num, inTicks: num })) })),
  powerUps: listOf(exactly({ id: matches(POWER_ID), kind: oneOf(powerUpKinds), x: num, y: num, vy: num, keepsBall: flag })),
  bricks: listOf(exactly({ x: num, y: num, durability: num, unbreakable: flag, regenerates: flag })),
  livesLost: num,
});
type WireBoard = ReturnType<typeof boardForJev>;

// What may fill each slot in OPTION_TEXT.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = (texts: readonly string[]) => texts.map(escape).join('|');
const SLOT: Record<string, string> = {
  x: '-?\\d+(?:\\.\\d+)?',
  kind: anyOf(powerUpKinds),
  effect: anyOf(Object.values(POWER_UP_EFFECTS)),
  cost: anyOf(Object.values(KEEPS_BALL)),
  power: POWER_ID.source.slice(1, -1),
  ball: BALL_ID.source.slice(1, -1),
  way: 'up|down',
};
const OPTION_PATTERN = Object.fromEntries(Object.entries(OPTION_TEXT).map(([name, text]) => {
  const pattern = text.split(/(\{\w+\})/).map(part => /^\{\w+\}$/.test(part) ? `(?:${SLOT[part.slice(1, -1)]})` : escape(part)).join('');
  return [name, new RegExp(`^${pattern}$`)];
})) as Record<OptionText, RegExp>;

const QUESTIONS = Object.keys(questions) as Array<Ask['question']>;

// Null when `request` is the health check or one of the game's asks on
// `model`; otherwise why not, in words that never repeat what was sent.
export function askRefusal(request: unknown, model: string): string | null {
  if (!isRecord(request) || !hasKeys(request, ['model', 'state', 'questions'])) return 'An ask holds a model, a state and questions, and nothing else.';
  if (request.model !== model) return `An ask names the model ${model}.`;
  const { questions: asked, state } = request;
  if (!isRecord(asked) || !hasKeys(asked, ['decision'])) return 'An ask holds one question, the decision.';
  const decision = asked.decision;
  if (!isRecord(decision) || !hasKeys(decision, ['type', 'instructions', 'criteria']) || decision.type !== 'choice' || !isRecord(decision.criteria)) return 'The decision is a choice with instructions and criteria.';
  if (JSON.stringify(decision) === JSON.stringify(HEALTH_QUESTION)) return JSON.stringify(state) === JSON.stringify({ tick: 0 }) ? null : 'The health check carries no board.';
  const question = QUESTIONS.find(name => decision.instructions === instructions(name));
  if (!question) return "The instructions are not one of the game's questions.";
  if (!isBoard(state)) return "The state is not the game's board.";
  const board = state as WireBoard;
  const criteria = decision.criteria;
  const keys = Object.keys(criteria);
  const textsFor = (key: string): readonly OptionText[] => {
    if (question === 'target') return TARGET_TEXT[key as typeof targetKeys[number]] ?? [];
    if (question === 'chase') return key === 'none' ? ['none'] : board.powerUps.some(power => power.id === key) ? CHASE_TEXT : [];
    return board.balls.some(ball => ball.id === key) ? TRACK_TEXT : [];
  };
  if (question === 'target' && keys.join() !== targetKeys.join()) return `A target ask offers ${targetKeys.join(', ')}, in that order.`;
  if (question === 'chase' && !keys.includes('none')) return 'A chase ask offers none.';
  if (keys.length < 2) return 'An ask offers at least two options.';
  for (const key of keys) {
    const texts = textsFor(key);
    if (!texts.length) return `An option of the ${question} ask is not one the game offers.`;
    if (!texts.some(text => matches(OPTION_PATTERN[text])(criteria[key]))) return `An option of the ${question} ask is not in the game's words.`;
  }
  return null;
}
