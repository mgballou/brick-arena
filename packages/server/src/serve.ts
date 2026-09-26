import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capFromEnv } from '../../jev/src/cap.ts';
import { linkFromEnv } from '../../jev/src/key.ts';
import { jevMiddleware, type ProxyOptions } from '../../jev/src/proxy.ts';
import { JEV_PATH } from '../../jev/src/wire.ts';
import { MATCHES_PATH, matchesMiddleware, storeFromEnv, type MatchStore } from './matches.ts';

// The hosted page (docs/deploy.md): the static build in dist/, plus the same
// Jev forwarder the dev server mounts, at the same path. The key is the host's
// JEV_API_KEY secret. There is no debug mode here, so the stand-in never plays.
// Each match's record goes to MATCHES_DIR (matches.ts).
//
//   pnpm build && JEV_API_KEY=... node packages/server/src/serve.ts

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function hostedApp(options: { dist: string; proxy: ProxyOptions; matches: MatchStore }) {
  const jev = jevMiddleware(options.proxy);
  const matches = matchesMiddleware(options.matches);
  const root = resolve(options.dist);
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    if (path === JEV_PATH) return void jev(req, res);
    if (path === MATCHES_PATH || path.startsWith(`${MATCHES_PATH}/`)) return void matches(req, res);
    // The host's health check. It never calls Jev.
    if (path === '/healthz') return void res.end('ok');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return void res.end();
    }
    let file: string;
    try {
      file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
    } catch {
      file = '';
    }
    let found = false;
    try {
      found = file.startsWith(root + sep) && statSync(file).isFile();
    } catch {
      // Not there.
    }
    if (!found) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return void res.end('Not found');
    }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    // Vite names built assets by content hash, so they never change.
    res.setHeader('cache-control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const link = linkFromEnv(process.env);
  const cap = capFromEnv(process.env);
  const dist = fileURLToPath(new URL('../../../dist', import.meta.url));
  const port = Number(process.env.PORT) || 8080;
  const matches = storeFromEnv(process.env);
  if (link.key) console.log(`[jev] ${link.model} at ${link.baseUrl}, key from the JEV_API_KEY secret`);
  else console.error('[jev] no JEV_API_KEY secret, so every visitor sees the down page');
  console.log(`[jev] cap: ${cap.limits.perVisitor} calls per visitor and ${cap.limits.total} in all, per UTC day`);
  console.log(`[matches] records in ${matches.dir}`);
  createServer(hostedApp({ dist, proxy: { link, keyFrom: 'the JEV_API_KEY secret', debug: false, cap }, matches }))
    .listen(port, () => console.log(`Brick Arena on port ${port}`));
}
