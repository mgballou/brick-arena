import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capFromEnv, type Cap } from '../../jev/src/cap.ts';
import { linkFromEnv } from '../../jev/src/key.ts';
import { jevMiddleware, type ProxyOptions } from '../../jev/src/proxy.ts';
import { JEV_PATH } from '../../jev/src/wire.ts';
import { adminSecretFromEnv, BACKSTAGE_PAGE, refuseUnlessAdmin } from './admin.ts';
import { MATCHES_PATH, matchReadSourceFromEnv, matchesMiddleware, storeFromEnv, type MatchReadSource, type MatchStore } from './matches.ts';
import { createRowWriter } from './rows.ts';
import { clientFromEnv } from './supabase.ts';

// The hosted page (docs/deploy.md): the static build in dist/, plus the same
// Jev forwarder the dev server mounts, at the same path. The key is the host's
// JEV_API_KEY secret. There is no debug mode here, so the stand-in never plays.
// Each match's record goes to MATCHES_DIR (matches.ts). The admin reads from
// Supabase when SUPABASE_URL and SUPABASE_SECRET_KEY are set, and otherwise
// from those files. With SUPABASE_WRITES=1 each live match also goes to
// Supabase as rows (rows.ts).
//
//   pnpm build && JEV_API_KEY=... ADMIN_SECRET=... node packages/server/src/serve.ts

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

export type HostedOptions = { dist: string; proxy: ProxyOptions; matches: MatchStore; matchReadSource?: MatchReadSource; admin: string | null };

// Everything the hosted page is started with, from the host's environment and
// nothing else: the Render service (render.yaml) and e2e/deployed.ts, which
// plays its title screen against a fake TypeSafe, both start from here. Debug
// is off, always. `rows` says whether live matches go to Supabase as rows.
export function hostedFromEnv(env: Record<string, string | undefined>, dist: string): HostedOptions & { proxy: { cap: Cap }; rows: boolean } {
  const link = linkFromEnv(env);
  const cap = capFromEnv(env);
  const client = clientFromEnv(env, line => console.error(`[supabase] ${line}`));
  // Render names the commit it built; elsewhere the build goes unnamed.
  const writer = client && createRowWriter(client, { build: env.RENDER_GIT_COMMIT?.trim() || null });
  const matches = storeFromEnv(env, writer?.take);
  const matchReadSource = matchReadSourceFromEnv(env, matches);
  const admin = adminSecretFromEnv(env);
  return { dist, proxy: { link, keyFrom: 'the JEV_API_KEY secret', debug: false, cap }, matches, matchReadSource, admin, rows: !!writer };
}

export function hostedApp(options: HostedOptions) {
  const jev = jevMiddleware(options.proxy);
  const matches = matchesMiddleware(options.matches, options.admin, options.matchReadSource);
  const root = resolve(options.dist);
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    if (path === JEV_PATH) return void jev(req, res);
    if (path === MATCHES_PATH || path.startsWith(`${MATCHES_PATH}/`)) return void matches(req, res);
    // The host's health check. It never calls Jev.
    if (path === '/healthz') return void res.end('ok');
    if (path === BACKSTAGE_PAGE && refuseUnlessAdmin(req, res, options.admin)) return;
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
  const options = hostedFromEnv(process.env, fileURLToPath(new URL('../../../dist', import.meta.url)));
  const port = Number(process.env.PORT) || 8080;
  const { link, cap } = options.proxy;
  if (link.key) console.log(`[jev] ${link.model} at ${link.baseUrl}, key from the JEV_API_KEY secret`);
  else console.error('[jev] no JEV_API_KEY secret, so every visitor sees the down page');
  console.log(`[jev] cap: ${cap.limits.perVisitor} calls per visitor and ${cap.limits.total} in all, per UTC day`);
  const readSource = options.matchReadSource && options.matchReadSource !== options.matches ? 'Supabase' : 'local files';
  console.log(`[matches] records in ${options.matches.dir}; ${options.admin ? `the admin reads ${readSource} with ADMIN_SECRET` : 'no ADMIN_SECRET, so no one reads them'}`);
  console.log(`[supabase] ${options.rows ? 'each live match is written as rows' : 'no rows written to Supabase'}`);
  createServer(hostedApp(options))
    .listen(port, () => console.log(`Brick Arena on port ${port}`));
}
