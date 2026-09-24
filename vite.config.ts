import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

// The route the browser calls. Everything the key touches stays on this side.
export const JEV_PATH = '/api/jev';
const JEV_BASE_URL = 'https://ai-gateway.vercel.sh/typesafe';
const JEV_MODEL = 'typesafe-ai/jev';
const KEY_FILE = join(homedir(), '.jev-key');
const UPSTREAM_TIMEOUT_MS = 8000;

// A key file is written by hand, so accept the shapes a hand makes: a bare
// token, a `NAME=token` line, quotes around it, notes on earlier lines. The
// value itself is never returned, printed or compared here.
function readKey(): string {
  let text: string;
  try {
    text = readFileSync(KEY_FILE, 'utf8');
  } catch {
    return '';
  }
  const line = text.split('\n').map(part => part.trim()).filter(Boolean).at(-1) ?? '';
  return line.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '').replace(/^["']|["']$/g, '').trim();
}

// Reads ~/.jev-key once, when the server starts, and holds it in this closure.
// It is added as a header on the way out and nothing else: it never enters the
// environment, never reaches a log line, and never reaches the browser. An
// upstream failure is reported back by status alone, so no response body that
// might quote the request can travel onward either.
type Outcome = { ok: true; body: string } | { ok: false; offline: string };

async function askUpstream(key: string, request: unknown): Promise<Outcome> {
  try {
    const upstream = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await upstream.text();
    if (!upstream.ok) return { ok: false, offline: `The gateway answered ${upstream.status}.` };
    return { ok: true, body };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, offline: timedOut ? 'The gateway did not answer in time.' : 'The gateway could not be reached.' };
  }
}

function jevProxy(): Plugin {
  let key = '';
  return {
    name: 'jev-proxy',
    configureServer(server: ViteDevServer) {
      key = readKey();
      if (!key) server.config.logger.warn(`  [jev] no key at ~/.jev-key, so the game will say Jev is offline`);

      server.middlewares.use(JEV_PATH, async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (!key) return send(503, { offline: 'No key at ~/.jev-key.' });

        // A health probe the title screen can run before anyone presses start,
        // so an offline Jev is named up front rather than mid-rally.
        if (req.method === 'GET') {
          const started = Date.now();
          const outcome = await askUpstream(key, { model: JEV_MODEL, state: { tick: 0 }, questions: { decision: { type: 'choice', instructions: 'Reply with ready.', criteria: { ready: 'The link is up' } } } });
          return outcome.ok
            ? send(200, { ok: true, ms: Date.now() - started })
            : send(200, { offline: outcome.offline });
        }
        if (req.method !== 'POST') return send(405, { offline: 'Ask Jev with POST or GET.' });

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { offline: 'That ask was not JSON.' });
        }

        const outcome = await askUpstream(key, { ...request, model: JEV_MODEL });
        if (!outcome.ok) return send(502, { offline: outcome.offline });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(outcome.body);
      });
    },
  };
}

export default defineConfig({ plugins: [react(), jevProxy()] });
