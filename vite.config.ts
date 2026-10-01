import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { capFromEnv } from './packages/jev/src/cap.ts';
import { JEV_DEFAULTS, readJevLink, type JevLink } from './packages/jev/src/key.ts';
import { jevMiddleware } from './packages/jev/src/proxy.ts';
import { JEV_PATH } from './packages/jev/src/wire.ts';
import { adminSecretFromEnv, BACKSTAGE_PAGE, refuseUnlessAdmin } from './packages/server/src/admin.ts';
import { MATCHES_PATH, matchesMiddleware, storeFromEnv } from './packages/server/src/matches.ts';

// Reads ~/.jev-key once, when the dev server starts, and hands it to the same
// forwarder the hosted server mounts (see packages/jev/src/proxy.ts).
function jevProxy(): Plugin {
  return {
    name: 'jev-proxy',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      // Vitest runs a dev server too. Tests never read a key.
      if (process.env.VITEST) return;
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
      // Debug mode lets the stand-in play. The browser reads the same switch.
      const debug = process.env.VITE_DEBUG === '1';
      const log = (line: string) => server.config.logger.warn(`  [jev] ${line}`);
      if (link.key) server.config.logger.info(`  [jev] ${link.model} at ${link.baseUrl}, key from ${keyFile}`);
      else log(`no key in ${keyFile}, so there is no game: the page will say Jev is down`);
      if (debug) log('DEBUG: a stand-in may play in place of Jev');

      server.middlewares.use(JEV_PATH, jevMiddleware({ link, keyFrom: keyFile, debug, cap: capFromEnv(process.env), log }));
    },
  };
}

// The same match store the hosted server keeps, so a match played on the dev
// server leaves its record in var/matches (or MATCHES_DIR).
function matchRecords(): Plugin {
  return {
    name: 'match-records',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (process.env.VITEST) return;
      const store = storeFromEnv(process.env);
      server.config.logger.info(`  [matches] records in ${store.dir}`);
      // Only the admin reads them, here as on the host (admin.ts). Vite serves
      // the page itself, so the gate runs ahead of it, for /matches too.
      const admin = adminSecretFromEnv(process.env);
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://host').pathname;
        if ((path === BACKSTAGE_PAGE || path === BACKSTAGE_PAGE.slice(0, -'.html'.length)) && refuseUnlessAdmin(req, res, admin)) return;
        next();
      });
      // This server writes no Supabase rows, so the admin reads its own files.
      server.middlewares.use(MATCHES_PATH, matchesMiddleware(store, admin, store, line =>server.config.logger.warn(`  [matches] ${line}`)));
    },
  };
}

// The hosted server's health check (serve.ts), here too, so `pnpm smoke:site`
// and the browser specs can ask the dev server whether it is up.
function healthCheck(): Plugin {
  return {
    name: 'health-check',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/healthz', (_req, res) => res.end('ok'));
    },
  };
}

export default defineConfig({
  plugins: [react(), jevProxy(), matchRecords(), healthCheck()],
  // The commit each PostHog event names as `build`, read as the server's
  // Supabase rows read it; null off Render.
  define: { __BUILD__: JSON.stringify(process.env.RENDER_GIT_COMMIT?.trim() || null) },
  // The game, the page that lists recorded matches, and the privacy page the
  // title screen links to.
  build: { rollupOptions: { input: { main: 'index.html', matches: 'matches.html', privacy: 'privacy.html' } } },
});
