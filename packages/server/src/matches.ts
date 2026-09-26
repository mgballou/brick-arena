import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMatchId, MATCHES_PATH, parseLine, parseRecord, SUMMARY_TYPES, summarize, type MatchLine, type MatchSummary } from './record.ts';

// Where the hosted server keeps match records (record.ts): one NDJSON file per
// match in one directory, appended to and never rewritten. On Render that
// directory is a persistent disk (docs/deploy.md); without one it lasts until
// the service restarts or sleeps.
//
//   POST /api/matches/<id>   lines to append; a new match must open with `start`
//   GET  /api/matches        the most recent matches, summarized, as JSON
//   GET  /api/matches/<id>   one match's record, as NDJSON
export { MATCHES_PATH };
export const MATCHES_DEFAULTS = {
  dir: fileURLToPath(new URL('../../../var/matches', import.meta.url)),
  // Past this the store takes no new match. A match is a few hundred KB, most
  // of it Jev's decisions.
  maxTotalBytes: 500 * 1024 * 1024,
  // Past this a match takes no more lines: five full levels are about 1 MB.
  maxMatchBytes: 4 * 1024 * 1024,
  // One write from the browser, about five seconds of play.
  maxPostBytes: 1024 * 1024,
  recent: 50,
} as const;

export type StoreLimits = { maxTotalBytes: number; maxMatchBytes: number };
export type Refused = 'bad-line' | 'no-start' | 'started' | 'full' | 'match-full';
export type MatchStore = {
  dir: string;
  append: (id: string, lines: MatchLine[]) => 'ok' | Refused;
  read: (id: string) => string | null;
  list: (limit?: number) => MatchSummary[];
};

export function createMatchStore(dir: string, limits: StoreLimits = MATCHES_DEFAULTS): MatchStore {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const fileOf = (id: string) => join(root, `${id}.ndjson`);
  const files = () => readdirSync(root).filter(name => name.endsWith('.ndjson') && isMatchId(name.slice(0, -'.ndjson'.length)));
  const used = () => files().reduce((sum, name) => sum + statSync(join(root, name)).size, 0);
  return {
    dir: root,
    append(id, lines) {
      const file = fileOf(id);
      const exists = existsSync(file);
      if (!exists && lines[0]?.type !== 'start') return 'no-start';
      if (lines.some((line, i) => line.type === 'start' && (exists || i > 0 || line.id !== id))) return 'started';
      // `type` leads every line, so the list can skip Jev's lines unparsed.
      // The server's clock, not the browser's, says when a match began and ended.
      const at = new Date().toISOString();
      const text = lines.map(({ type, ...rest }) => JSON.stringify({ type, ...rest, ...(type === 'start' || type === 'end' ? { at } : {}) }) + '\n').join('');
      const bytes = Buffer.byteLength(text);
      if (!exists && used() + bytes > limits.maxTotalBytes) return 'full';
      if ((exists ? statSync(file).size : 0) + bytes > limits.maxMatchBytes) return 'match-full';
      appendFileSync(file, text);
      return 'ok';
    },
    read(id) {
      return isMatchId(id) && existsSync(fileOf(id)) ? readFileSync(fileOf(id), 'utf8') : null;
    },
    list(limit = MATCHES_DEFAULTS.recent) {
      // Ids open with their UTC start, so the names sort newest last.
      return files().sort().reverse().slice(0, limit).flatMap(name => {
        const text = readFileSync(join(root, name), 'utf8');
        const kept = text.split('\n').filter(line => SUMMARY_TYPES.has(/^\{"type":"(\w+)"/.exec(line)?.[1] ?? ''));
        const summary = summarize(parseRecord(kept.join('\n')));
        return summary ? [summary] : [];
      });
    },
  };
}

// MATCHES_DIR names the directory; unset, it is var/matches in the checkout.
export function storeFromEnv(env: Record<string, string | undefined>): MatchStore {
  return createMatchStore(env.MATCHES_DIR?.trim() || MATCHES_DEFAULTS.dir);
}

async function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Mounted at MATCHES_PATH by the hosted server and the dev server; the dev
// server strips the mount from the URL and the hosted one doesn't. Match records are the game alone, so
// reading them takes no key.
export function matchesMiddleware(store: MatchStore, log: (line: string) => void = line => console.error(`[matches] ${line}`)) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.statusCode = status;
      res.setHeader('content-type', type);
      res.setHeader('cache-control', 'no-store');
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    const rest = (path.startsWith(MATCHES_PATH) ? path.slice(MATCHES_PATH.length) : path).replace(/^\/+|\/+$/g, '');
    if (rest === '') {
      if (req.method !== 'GET') return send(405, { ok: false, error: 'List matches with GET.' });
      return send(200, { ok: true, matches: store.list() });
    }
    if (!isMatchId(rest)) return send(404, { ok: false, error: 'No such match.' });
    if (req.method === 'GET') {
      const text = store.read(rest);
      return text === null ? send(404, { ok: false, error: 'No such match.' }) : send(200, text, 'application/x-ndjson; charset=utf-8');
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'Write a match with POST.' });
    const body = await readBody(req, MATCHES_DEFAULTS.maxPostBytes);
    if (body === null) return send(413, { ok: false, error: 'That write is too large.' });
    const lines = body.split('\n').filter(Boolean).map(parseLine);
    if (!lines.length || lines.some(line => line === null)) return send(400, { ok: false, error: 'Every line must be a match record line.' });
    const written = store.append(rest, lines as MatchLine[]);
    if (written === 'full' || written === 'match-full') log(`refused ${rest}: ${written === 'full' ? 'the store is full' : 'the match is at its size limit'}`);
    return written === 'ok' ? send(200, { ok: true }) : send(written === 'full' || written === 'match-full' ? 507 : 409, { ok: false, error: written });
  };
}
