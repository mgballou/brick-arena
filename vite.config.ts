import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { JEV_DEFAULTS, readJevLink, type JevLink } from './packages/jev/src/key';

// The route the browser calls. Everything the key touches stays on this side.
export const JEV_PATH = '/api/jev';
const UPSTREAM_TIMEOUT_MS = 8000;

// Reads ~/.jev-key once, when the server starts, and holds it in this closure.
// It is added as a header on the way out and nothing else: it never enters the
// environment, never reaches a log line, and never reaches the browser. An
// upstream failure is reported back by status alone, so no response body that
// might quote the request can travel onward either.
type Outcome = { ok: true; body: string } | { ok: false; offline: string };

async function askUpstream(link: JevLink, request: unknown): Promise<Outcome> {
  try {
    const upstream = await fetch(`${link.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${link.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await upstream.text();
    if (!upstream.ok) return { ok: false, offline: `Jev answered ${upstream.status}.` };
    return { ok: true, body };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, offline: timedOut ? 'Jev did not answer in time.' : 'Jev could not be reached.' };
  }
}

function jevProxy(): Plugin {
  return {
    name: 'jev-proxy',
    configureServer(server: ViteDevServer) {
      // JEV_KEY_FILE names another key file, with JEV_BASE_URL and JEV_MODEL
      // to match (a dummy key and a local stub, say). The endpoint overrides
      // apply only with it, so the real key only ever goes where its own file
      // or the defaults say. The key itself never comes from the environment.
      const override = process.env.JEV_KEY_FILE;
      const keyFile = override || JEV_DEFAULTS.keyFile;
      const fromFile = readJevLink(keyFile);
      const link: JevLink = override
        ? { ...fromFile, baseUrl: process.env.JEV_BASE_URL || fromFile.baseUrl, model: process.env.JEV_MODEL || fromFile.model }
        : fromFile;
      if (link.key) server.config.logger.info(`  [jev] ${link.model} at ${link.baseUrl}, key from ${keyFile}`);
      else server.config.logger.warn(`  [jev] no key in ${keyFile}, so the game will say Jev is offline`);

      server.middlewares.use(JEV_PATH, async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (!link.key) return send(503, { offline: `No key in ${keyFile}.` });

        // A health probe the title screen can run before anyone presses start,
        // so an offline Jev is named up front rather than mid-rally.
        if (req.method === 'GET') {
          const started = Date.now();
          const outcome = await askUpstream(link, { model: link.model, state: { tick: 0 }, questions: { decision: { type: 'choice', instructions: 'Reply with ready.', criteria: { ready: 'The link is up' } } } });
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

        const outcome = await askUpstream(link, { ...request, model: link.model });
        if (!outcome.ok) return send(502, { offline: outcome.offline });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(outcome.body);
      });
    },
  };
}

export default defineConfig({ plugins: [react(), jevProxy()] });
