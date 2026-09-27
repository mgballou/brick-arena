import type { Ask, Decision } from '../../engine/src/index';
import { answeredBy, downOf, fromResponse, JEV_PATH, refusal, toRequest, type AnsweredBy, type Down, type SystemOneResponse } from '../../jev/src/wire';

// The browser only ever talks to its own origin's /api/jev, which holds the
// key and forwards to TypeSafe (packages/jev/src/proxy.ts, on the dev server
// and the hosted one). No key and no TypeSafe address exist on this side.
const DEADLINE_MS = 2000;

// Debug mode is one switch, set when the dev server starts: VITE_DEBUG=1. Only
// then may the stand-in play, and the screen says so for the whole match.
export const DEBUG = import.meta.env.VITE_DEBUG === '1';

// `down` means the forwarder said Jev can't answer: the page shows the down
// page and no board. Any other failure keeps the title screen's refusal.
export type Probe = { ok: true; ms: number; answeredBy: AnsweredBy } | { ok: false; reason: string; down?: Down };

// The check before a match. The proxy refuses a stand-in outside debug mode;
// this refuses it again, so the browser never trusts the server alone.
export async function probeJev(): Promise<Probe> {
  try {
    const response = await fetch(JEV_PATH, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { ok?: boolean; ms?: number; error?: string; answeredBy?: AnsweredBy };
    const down = downOf(response.status, body);
    if (down) return { ok: false, reason: 'Jev is down.', down };
    if (!body.ok) return { ok: false, reason: body.error ?? `The game server answered ${response.status}.` };
    const by = body.answeredBy ?? 'live';
    const refused = refusal(by, DEBUG);
    return refused ? { ok: false, reason: refused } : { ok: true, ms: body.ms ?? 0, answeredBy: by };
  } catch {
    return { ok: false, reason: 'The game server did not answer.' };
  }
}

// `down` means the forwarder said Jev can't answer (auth, credits, rate, an
// upstream failure or timeout, or the day's cap), and ends the match on the
// down page. `offline` means this side lost the game server, or refused a
// stand-in; `timeout` and `bad-answer` mean Jev is up but missed this one.
export type JevAnswer =
  | { ok: true; decision: Decision; choice: string; ms: number; answeredBy: AnsweredBy }
  | { ok: false; kind: 'down'; down: Down; reason: string; ms: number }
  | { ok: false; kind: 'offline' | 'timeout' | 'bad-answer'; reason: string; ms: number };

export async function askJev(ask: Ask): Promise<JevAnswer> {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  let response: Response;
  try {
    response = await fetch(JEV_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The proxy sets the model; this one is a placeholder.
      body: JSON.stringify(toRequest(ask, 'jev')),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return timedOut
      ? { ok: false, kind: 'timeout', reason: `No answer in ${DEADLINE_MS} ms.`, ms: ms() }
      : { ok: false, kind: 'offline', reason: 'The game server did not answer.', ms: ms() };
  }
  const body = await response.json().catch(() => ({})) as SystemOneResponse & { error?: string };
  const down = downOf(response.status, body);
  if (down) return { ok: false, kind: 'down', down, reason: 'Jev is down.', ms: ms() };
  if (!response.ok) return { ok: false, kind: 'offline', reason: body.error ?? `The game server answered ${response.status}.`, ms: ms() };
  const by = answeredBy(body);
  const refused = refusal(by, DEBUG);
  if (refused) return { ok: false, kind: 'offline', reason: refused, ms: ms() };
  try {
    const decision = fromResponse(ask, body);
    const choice = String((body.answers?.decision as { choice?: string } | undefined)?.choice ?? '');
    return { ok: true, decision, choice, ms: ms(), answeredBy: by };
  } catch (error) {
    return { ok: false, kind: 'bad-answer', reason: error instanceof Error ? error.message : String(error), ms: ms() };
  }
}
