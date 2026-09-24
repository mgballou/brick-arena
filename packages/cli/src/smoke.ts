import { createBoard, askForDecision, step } from '../../engine/src/index.ts';
import { toRequest, fromResponse } from '../../jev/src/wire.ts';
import { JEV_DEFAULTS, readJevLink } from '../../jev/src/key.ts';

// One live call, to confirm the key in ~/.jev-key reaches Jev: pnpm smoke
const GAME_DEADLINE = 1000;
const { baseUrl, model, key: apiKey } = readJevLink();
if (!apiKey) {
  console.error(`No TypeSafe key in ${JEV_DEFAULTS.keyFile}. The live smoke test needs one.`);
  process.exit(1);
}

let board = createBoard(20260919, 0);
for (let i = 0; i < 30; i++) board = step(board);
const ask = askForDecision(board);
const request = toRequest(ask, model);

const url = `${baseUrl.replace(/\/+$/, '')}/v1/systemone`;
console.log(`One ${ask.question} call to ${url}`);
console.log(`Offered: ${Object.keys(request.questions.decision.criteria).join(', ')}`);

const t0 = performance.now();
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5000),
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json() as Record<string, unknown>;

  console.log(`\nHTTP ${res.status}, ${ms}ms`);

  if (!res.ok) {
    console.log(`Error: ${JSON.stringify(body)}`);
    console.log(`\nEndpoint responded but returned an error.`);
    process.exit(1);
  }

  const decision = fromResponse(ask, body as never);
  const answer = (body['answers'] as Record<string, Record<string, unknown>> | undefined)?.['decision'];
  console.log(`Choice: ${answer?.['choice']}`);
  console.log(`Decision: ${JSON.stringify(decision)}`);
  console.log(`Latency: ${ms}ms`);

  const usage = body['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
  if (usage) {
    const inp = usage.input_tokens;
    const out = usage.output_tokens;
    console.log(`Usage: input_tokens=${inp ?? 'absent'}, output_tokens=${out ?? 'absent'}`);
    if (typeof inp === 'number') {
      const estimate = 750;
      const ratio = inp / estimate;
      if (ratio > 2 || ratio < 0.5) {
        console.log(`\nMeasured input tokens (${inp}) differ from the desk estimate (~${estimate}) by more than 2x.`);
      } else {
        console.log(`\nMeasured input tokens (${inp}) are within 2x of the desk estimate (~${estimate}).`);
      }
    }
  } else {
    console.log(`Usage: field absent from response`);
  }

  console.log(`\nEndpoint is available and responds correctly.`);
  if (ms > GAME_DEADLINE) {
    console.log(`Latency (${ms}ms) exceeds the ${GAME_DEADLINE}ms game deadline; Jev would miss most asks.`);
  }
} catch (err) {
  const ms = Math.round(performance.now() - t0);
  console.log(`\nFailed after ${ms}ms: ${err instanceof Error ? err.message : String(err)}`);
  console.log(`\nEndpoint is not available.`);
  process.exit(1);
}
