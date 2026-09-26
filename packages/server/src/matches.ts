import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseUnlessAdmin } from './admin.ts';
import { foldSummary, idTime, isMatchId, MATCHES_PATH, parseLine, parseRecord, startSummary, summarize, type MatchLine, type MatchSummary } from './record.ts';

// Where the hosted server keeps match records (record.ts): one NDJSON file per
// match in one directory, appended to and never rewritten. This process is the
// only writer. On Render that
// directory is a persistent disk (docs/deploy.md); without one it lasts until
// the service restarts or sleeps.
//
//   POST /api/matches/<id>   lines to append; a new match must open with `start`
//   GET  /api/matches        the most recent matches, summarized, as JSON (admin only)
//   GET  /api/matches/<id>   one match's record, as NDJSON (admin only)
//
// The game writes without signing in; only the admin reads (admin.ts).
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
export type Refused = 'bad-line' | 'no-start' | 'started' | 'bad-time' | 'full' | 'match-full';
export type MatchStore = {
  dir: string;
  append: (id: string, lines: MatchLine[]) => 'ok' | Refused;
  read: (id: string) => string | null;
  list: (limit?: number) => MatchSummary[];
};

// A new match's id must name a start within this much of the server's clock,
// so no one can date a match ahead and hold the top of the list.
const ID_SKEW_MS = 60 * 60 * 1000;

// Each match's size and summary are read once, when the store opens, and kept
// up to date as lines arrive, so a write or the list never reads the files.
export function createMatchStore(dir: string, limits: StoreLimits = MATCHES_DEFAULTS, now: () => number = Date.now): MatchStore {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const fileOf = (id: string) => join(root, `${id}.ndjson`);
  const matches = new Map<string, { bytes: number; summary: MatchSummary | null }>();
  let used = 0;
  for (const name of readdirSync(root)) {
    const id = name.slice(0, -'.ndjson'.length);
    if (!name.endsWith('.ndjson') || !isMatchId(id)) continue;
    const text = readFileSync(join(root, name), 'utf8');
    const bytes = Buffer.byteLength(text);
    matches.set(id, { bytes, summary: summarize(parseRecord(text)) });
    used += bytes;
  }
  return {
    dir: root,
    append(id, lines) {
      const match = matches.get(id);
      if (!match && lines[0]?.type !== 'start') return 'no-start';
      if (lines.some((line, i) => line.type === 'start' && (match || i > 0 || line.id !== id))) return 'started';
      if (!match && Math.abs(idTime(id) - now()) > ID_SKEW_MS) return 'bad-time';
      // The server's clock, not the browser's, says when a match began and ended.
      const at = new Date(now()).toISOString();
      const stamped = lines.map(line => line.type === 'start' || line.type === 'end' ? { ...line, at } : line);
      const text = stamped.map(line => JSON.stringify(line) + '\n').join('');
      const bytes = Buffer.byteLength(text);
      if (used + bytes > limits.maxTotalBytes) return 'full';
      if ((match?.bytes ?? 0) + bytes > limits.maxMatchBytes) return 'match-full';
      appendFileSync(fileOf(id), text);
      used += bytes;
      const entry = match ?? { bytes: 0, summary: stamped[0].type === 'start' ? startSummary(stamped[0]) : null };
      entry.bytes += bytes;
      if (entry.summary) for (const line of stamped) foldSummary(entry.summary, line);
      matches.set(id, entry);
      return 'ok';
    },
    read(id) {
      return matches.has(id) ? readFileSync(fileOf(id), 'utf8') : null;
    },
    list(limit = MATCHES_DEFAULTS.recent) {
      // Ids open with their UTC start, so the names sort newest last.
      return [...matches.keys()].sort().reverse().slice(0, limit).flatMap(id => matches.get(id)!.summary ?? []);
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
// server strips the mount from the URL and the hosted one doesn't. `admin` is
// the ADMIN_SECRET; without it no one reads a record.
export function matchesMiddleware(store: MatchStore, admin: string | null, log: (line: string) => void = line => console.error(`[matches] ${line}`)) {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
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
      if (refuseUnlessAdmin(req, res, admin)) return;
      return send(200, { ok: true, matches: store.list() });
    }
    if (!isMatchId(rest)) return send(404, { ok: false, error: 'No such match.' });
    if (req.method === 'GET') {
      if (refuseUnlessAdmin(req, res, admin)) return;
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
  // A write cut off mid-body, or a disk that fails, costs that write and
  // nothing else: never the server, which also carries the game and Jev.
  return (req: IncomingMessage, res: ServerResponse) => handle(req, res).catch(error => {
    log(`write failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent && !res.destroyed) { res.statusCode = 500; res.end(); }
  });
}
