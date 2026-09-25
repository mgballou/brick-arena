import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JevLink } from './key.ts';
import { answeredBy, refusal, type AnsweredBy } from './wire.ts';

// The dev server's side of /api/jev (see vite.config.ts). The key arrives in
// `link` and is added as a header on the way out and nothing else: it never
// enters the environment, never reaches a log line, and never reaches the
// browser. An upstream failure is reported back by status alone, so no response
// body that might quote the request can travel onward either.
const UPSTREAM_TIMEOUT_MS = 8000;

export type Outcome = { ok: true; body: string; answeredBy: AnsweredBy } | { ok: false; offline: string; answeredBy?: AnsweredBy };
export type Health = { ok: true; ms: number; answeredBy: AnsweredBy } | { ok: false; offline: string; answeredBy?: AnsweredBy };
export type ProxyOptions = { link: JevLink; keyFile: string; debug: boolean; timeoutMs?: number };

// One call upstream. A stand-in's answer is refused here unless in debug mode.
export async function askUpstream(options: ProxyOptions, request: unknown): Promise<Outcome> {
  const { link } = options;
  if (!link.key) return { ok: false, offline: `No key in ${options.keyFile}.` };
  let body: string;
  try {
    const upstream = await fetch(`${link.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${link.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    });
    body = await upstream.text();
    if (!upstream.ok) return { ok: false, offline: `Jev answered ${upstream.status}.` };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, offline: timedOut ? 'Jev did not answer in time.' : 'Jev could not be reached.' };
  }
  let by: AnsweredBy;
  try {
    by = answeredBy(JSON.parse(body));
  } catch {
    return { ok: false, offline: 'Jev answered with something that is not JSON.' };
  }
  const refused = refusal(by, options.debug);
  return refused ? { ok: false, offline: refused, answeredBy: by } : { ok: true, body, answeredBy: by };
}

// The check the title screen runs before a match: one real call, whose reply
// says who answered.
export async function checkHealth(options: ProxyOptions): Promise<Health> {
  const started = Date.now();
  const outcome = await askUpstream(options, { model: options.link.model, state: { tick: 0 }, questions: { decision: { type: 'choice', instructions: 'Reply with ready.', criteria: { ready: 'The link is up' } } } });
  return outcome.ok ? { ok: true, ms: Date.now() - started, answeredBy: outcome.answeredBy } : outcome;
}

export function jevMiddleware(options: ProxyOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET') return send(200, await checkHealth(options));
    if (req.method !== 'POST') return send(405, { offline: 'Ask Jev with POST or GET.' });

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, { offline: 'That ask was not JSON.' });
    }
    const outcome = await askUpstream(options, { ...request, model: options.link.model });
    if (!outcome.ok) return send(502, outcome);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(outcome.body);
  };
}
