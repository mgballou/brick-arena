import { appendFileSync, readFileSync } from 'node:fs';
import type { SystemOneRequest, SystemOneResponse } from './wire';

export type Transport = (request: SystemOneRequest) => Promise<SystemOneResponse>;

// One line of a call recording. `at` and `ms` are wall-clock facts of a
// captured call, and null in a synthetic one, which carries no time at all.
export type CallRecord = {
  synthetic: boolean;
  at: string | null;
  request: SystemOneRequest;
  response?: SystemOneResponse;
  error?: string;
  ms: number | null;
};

export function httpTransport(options: { baseUrl: string; apiKey: string; timeoutMs?: number }): Transport {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/systemone`;
  return async request => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    const body = await response.json().catch(() => ({})) as SystemOneResponse & { message?: string; error_type?: string };
    if (!response.ok) throw new Error(`Jev ${response.status} ${body.error_type ?? ''}: ${body.message ?? response.statusText}`.trim());
    return body;
  };
}

export function recordingTransport(inner: Transport, path: string): Transport {
  return async request => {
    const start = performance.now();
    const write = (outcome: Pick<CallRecord, 'response' | 'error'>) => {
      const record: CallRecord = { synthetic: false, at: new Date().toISOString(), request, ...outcome, ms: Math.round(performance.now() - start) };
      appendFileSync(path, JSON.stringify(record) + '\n');
    };
    try {
      const response = await inner(request);
      write({ response });
      return response;
    } catch (error) {
      write({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}

export function readRecording(path: string): CallRecord[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as CallRecord);
}

// Plays a recording back in order. Each request must match the recorded one
// exactly, so a replay can never answer a question it was not asked.
// `wait` receives each call's recorded ms (0 when synthetic): sleep on it to
// replay in real time, or add it to a virtual clock to replay in game time.
export function replayTransport(records: readonly CallRecord[], options: { wait?: (ms: number) => unknown } = {}): Transport {
  let next = 0;
  return async request => {
    const record = records[next];
    if (!record) throw new Error(`recording exhausted after ${records.length} calls`);
    if (JSON.stringify(record.request) !== JSON.stringify(request)) throw new Error(`request ${next} does not match the recording`);
    next++;
    await options.wait?.(record.ms ?? 0);
    if (record.error !== undefined) throw new Error(record.error);
    if (!record.response) throw new Error(`recorded call ${next - 1} has neither response nor error`);
    return record.response;
  };
}
