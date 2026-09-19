import type { Ask, BoardState, Decision } from '../../engine/src/index';

// Wire shape of POST {baseUrl}/v1/systemone, as documented by TypeSafe and
// mirrored by Vercel AI Gateway (https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe).
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string | null> };
export type SystemOneRequest = { model: string; state: unknown; questions: { decision: ChoiceQuestion } };
// Only `type` and `choice` are documented for a Choice answer; any per-option
// probabilities are kept in the recording as received, never read here.
export type ChoiceAnswer = { type: 'choice'; choice: string; [field: string]: unknown };
export type SystemOneResponse = { model?: string; answers: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number } };

// The four `target` options, in the order askForDecision builds them.
export const targetKeys = ['landing', 'center', 'left', 'right'] as const;

function boardForJev(state: BoardState) {
  return {
    tick: state.tick,
    width: state.width,
    height: state.height,
    paddle: { x: state.paddleX, width: state.paddleWidth, targetX: state.paddleTargetX, speed: state.paddleSpeed, magnet: state.magnetPaddle },
    balls: state.balls.map(({ id, x, y, vx, vy, tracked, piercing }) => ({ id, x, y, vx, vy, tracked, piercing })),
    powerUps: state.powerUps.map(({ id, kind, x, y, vy }) => ({ id, kind, x, y, vy })),
    bricks: state.bricks.filter(brick => brick.unbreakable || brick.durability > 0).map(({ x, y, durability, unbreakable, regenerates }) => ({ x, y, durability, unbreakable, regenerates })),
    livesLost: state.livesLost,
  };
}

function criteriaFor(ask: Ask): Record<string, string> {
  const { state, options } = ask;
  if (ask.question === 'target') {
    if (options.length !== targetKeys.length) throw new Error(`target ask has ${options.length} options, expected ${targetKeys.length}`);
    const [landing, center, left, right] = options.map(Number);
    return {
      landing: `Move the paddle under the tracked ball's predicted landing point, x=${landing.toFixed(1)}`,
      center: `Move the paddle to the middle of the board, x=${center}`,
      left: `Move the paddle toward the left side, x=${left}`,
      right: `Move the paddle toward the right side, x=${right}`,
    };
  }
  if (ask.question === 'chase') {
    return Object.fromEntries(options.map(option => {
      const id = String(option);
      if (id === 'none') return [id, 'Ignore every falling power-up and keep playing the ball'];
      const power = state.powerUps.find(item => item.id === id);
      return [id, power ? `Catch the falling ${power.kind} power-up at x=${power.x.toFixed(1)}, y=${power.y.toFixed(1)}` : `Catch power-up ${id}`];
    }));
  }
  return Object.fromEntries(options.map(option => {
    const id = String(option);
    const ball = state.balls.find(item => item.id === id);
    return [id, ball ? `Follow ${id} at x=${ball.x.toFixed(1)}, y=${ball.y.toFixed(1)}, moving ${ball.vy > 0 ? 'down' : 'up'}` : `Follow ${id}`];
  }));
}

const instructions: Record<Ask['question'], string> = {
  target: 'Where should the paddle go next so the ball is not lost and bricks keep breaking?',
  chase: 'A power-up is falling. Which one should the paddle catch, if any?',
  track: 'Several balls are in play. Which ball should the paddle follow?',
};

export function toRequest(ask: Ask, model: string): SystemOneRequest {
  return { model, state: boardForJev(ask.state), questions: { decision: { type: 'choice', instructions: instructions[ask.question], criteria: criteriaFor(ask) } } };
}

export function fromResponse(ask: Ask, response: SystemOneResponse): Decision {
  const answer = response.answers?.decision as Partial<ChoiceAnswer> | undefined;
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string') throw new Error(`Jev answer is not a choice: ${JSON.stringify(answer)}`);
  const keys = Object.keys(criteriaFor(ask));
  if (!keys.includes(answer.choice)) throw new Error(`Jev chose "${answer.choice}", outside the offered set ${JSON.stringify(keys)}`);
  if (ask.question === 'target') return { kind: 'target', x: Number(ask.options[targetKeys.indexOf(answer.choice as typeof targetKeys[number])]) };
  if (ask.question === 'chase') return { kind: 'chase', powerUpId: answer.choice };
  return { kind: 'track', ballId: answer.choice };
}
