import { raceWithLatency } from './race';
import { jevPlayer } from './player';
import type { CallRecord, Transport } from './transport';
import { targetKeys, type SystemOneResponse } from './wire';

// Builds the hand-written recording in docs/jev-calls.synthetic.ndjson. No call
// was made: each answer follows the documented response shape
// ({ model, answers: { <key>: { type: 'choice', choice } }, usage }) with a
// fixed rule, and one call returns the documented error shape. Every record
// says `synthetic: true` and carries no time and no token counts.
export const SYNTHETIC = { model: 'typesafe-ai/jev', seed: 20260919, level: 0, maxTicks: 12000, failedCall: 6 } as const;

export async function syntheticRecording(): Promise<CallRecord[]> {
  const records: CallRecord[] = [];
  const transport: Transport = async request => {
    const keys = Object.keys(request.questions.decision.criteria);
    if (records.length === SYNTHETIC.failedCall) {
      const error = 'Jev 503 unavailable: synthetic failure, shaped like the documented { message, error_type } error';
      records.push({ synthetic: true, at: null, request, error, ms: null });
      throw new Error(error);
    }
    const choice = keys.includes(targetKeys[0]) ? targetKeys[0] : keys[0];
    const response: SystemOneResponse = { model: SYNTHETIC.model, answers: { decision: { type: 'choice', choice } } };
    records.push({ synthetic: true, at: null, request, response, ms: null });
    return response;
  };
  await raceWithLatency(jevPlayer({ model: SYNTHETIC.model, transport }), { seed: SYNTHETIC.seed, level: SYNTHETIC.level, maxTicks: SYNTHETIC.maxTicks, now: () => 0 });
  return records;
}
