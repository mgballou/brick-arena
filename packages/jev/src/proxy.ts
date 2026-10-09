import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Cap } from './cap.ts';
import type { JevLink } from './key.ts';
import { answeredBy, ASK_MODEL, askRefusal, DOWN_STATUS, healthRequest, refusal, type AnsweredBy, type Down, type DownReply } from './wire.ts';

// The one Jev forwarder behind /api/jev. The dev server (vite.config.ts) and
// the hosted server (packages/server/src/serve.ts) both mount jevMiddleware;
// they differ only in where `link` comes from. The key is added as a header on
// the way out and nothing else: it never reaches a log line or the browser.
// When Jev can't answer, the browser gets DOWN_STATUS and a `down` reason and
// nothing more; the upstream detail goes to the server log alone. It forwards
// only the game's own asks (askRefusal in wire.ts) and refuses the rest with
// 400, so the key serves the game and nothing else.
const UPSTREAM_TIMEOUT_MS = 8000;
// An ask is one board and a few options, a few KB. Far past that is not the game.
const MAX_ASK_BYTES = 256 * 1024;

// `offline` is the upstream detail, for the server log only.
export type Outcome = { ok: true; body: string; answeredBy: AnsweredBy } | { ok: false; offline: string; answeredBy?: AnsweredBy };
export type Health = { ok: true; ms: number; answeredBy: AnsweredBy } | { ok: false; offline: string; answeredBy?: AnsweredBy };
// `keyFrom` names where the key came from, for the log. `cap` limits calls per
// visitor and per day (cap.ts). `log` receives the upstream detail.
export type ProxyOptions = { link: JevLink; keyFrom: string; debug: boolean; timeoutMs?: number; cap?: Cap; log?: (line: string) => void };

// One call upstream, and the last place an ask is checked before it leaves. A
// stand-in's answer is refused here unless in debug mode.
export async function askUpstream(options: ProxyOptions, request: unknown): Promise<Outcome> {
  const { link } = options;
  if (!link.key) return { ok: false, offline: `No key in ${options.keyFrom}.` };
  const refused = askRefusal(request, link.model);
  if (refused) return { ok: false, offline: `Not sent: ${refused}` };
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  let body: string;
  try {
    const upstream = await fetch(`${link.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${link.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await upstream.text();
    if (!upstream.ok) return { ok: false, offline: `Jev answered ${upstream.status}: ${body.slice(0, 500)}` };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const cause = error instanceof Error ? String((error.cause as { code?: string } | undefined)?.code ?? error.message) : String(error);
    return { ok: false, offline: timedOut ? `Jev did not answer in ${timeoutMs} ms.` : `Jev could not be reached: ${cause}` };
  }
  let by: AnsweredBy;
  try {
    by = answeredBy(JSON.parse(body));
  } catch {
    return { ok: false, offline: 'Jev answered with something that is not JSON.' };
  }
  const standIn = refusal(by, options.debug);
  return standIn ? { ok: false, offline: standIn, answeredBy: by } : { ok: true, body, answeredBy: by };
}

// The check the title screen runs before a match: one real call, whose reply
// says who answered.
export async function checkHealth(options: ProxyOptions): Promise<Health> {
  const started = Date.now();
  const outcome = await askUpstream(options, healthRequest(options.link.model));
  return outcome.ok ? { ok: true, ms: Date.now() - started, answeredBy: outcome.answeredBy } : outcome;
}

// Render appends the client address to X-Forwarded-For. Trust the one proxy
// hop and take the rightmost untrusted entry; values farther left are caller
// controlled. The socket address is the fallback if the header is absent.
export function clientAddress(headers: IncomingMessage['headers'], remoteAddress?: string): string {
  const forwarded = headers['x-forwarded-for'];
  const addresses = (Array.isArray(forwarded) ? forwarded : [forwarded])
    .flatMap(value => value?.split(',') ?? [])
    .map(value => value.trim())
    .filter(Boolean);
  return addresses.at(-1) || remoteAddress || 'unknown';
}

async function readAsk(req: IncomingMessage): Promise<Record<string, unknown> | 'too-big' | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_ASK_BYTES) return 'too-big';
    chunks.push(chunk as Buffer);
  }
  try {
    const ask = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof ask === 'object' && ask !== null && !Array.isArray(ask) ? ask : null;
  } catch {
    return null;
  }
}

export function jevMiddleware(options: ProxyOptions) {
  const log = options.log ?? ((line: string) => console.error(`[jev] ${line}`));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const down = (why: Down, detail: string, by?: AnsweredBy) => {
      log(`down (${why}): ${detail}`);
      const reply: DownReply = by ? { ok: false, down: why, answeredBy: by } : { ok: false, down: why };
      send(DOWN_STATUS, reply);
    };
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, { ok: false, error: 'Ask Jev with POST or GET.' });

    let ask: Record<string, unknown> | null = null;
    if (req.method === 'POST') {
      const read = await readAsk(req);
      if (read === 'too-big') return send(413, { ok: false, error: 'That ask is too large.' });
      if (!read) return send(400, { ok: false, error: 'That ask was not JSON.' });
      const refused = askRefusal(read, ASK_MODEL);
      if (refused) {
        log(`refused an ask: ${refused}`);
        return send(400, { ok: false, error: `Jev answers only the game's own asks. ${refused}` });
      }
      ask = read;
    }

    const taken = options.cap?.take(clientAddress(req.headers, req.socket.remoteAddress)) ?? 'ok';
    if (taken !== 'ok') {
      const limits = options.cap!.limits;
      return down('used-up', taken === 'visitor' ? `a visitor reached ${limits.perVisitor} calls today` : `the day's ${limits.total} calls are spent`);
    }

    if (!ask) {
      const health = await checkHealth(options);
      return health.ok ? send(200, health) : down('unreachable', health.offline, health.answeredBy);
    }
    const outcome = await askUpstream(options, { ...ask, model: options.link.model });
    if (!outcome.ok) return down('unreachable', outcome.offline, outcome.answeredBy);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(outcome.body);
  };
  // An ask cut off mid-body (the browser drops one at its deadline) costs that
  // ask and nothing else: never the server, which also carries the page.
  return (req: IncomingMessage, res: ServerResponse) => handle(req, res).catch(error => {
    log(`ask failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent && !res.destroyed) { res.statusCode = 500; res.end(); }
  });
}
