import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { JEV_DEFAULTS, readJevLink, type JevLink } from './packages/jev/src/key.ts';
import { jevMiddleware } from './packages/jev/src/proxy.ts';

// The route the browser calls. Everything the key touches stays on this side.
export const JEV_PATH = '/api/jev';

// Reads ~/.jev-key once, when the server starts, and holds it in the proxy's
// closure (see packages/jev/src/proxy.ts).
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
      // Debug mode lets the stand-in play. The browser reads the same switch.
      const debug = process.env.VITE_DEBUG === '1';
      if (link.key) server.config.logger.info(`  [jev] ${link.model} at ${link.baseUrl}, key from ${keyFile}`);
      else server.config.logger.warn(`  [jev] no key in ${keyFile}, so there is no game: the title screen will say Jev isn't reachable`);
      if (debug) server.config.logger.warn('  [jev] DEBUG: a stand-in may play in place of Jev');

      server.middlewares.use(JEV_PATH, jevMiddleware({ link, keyFile, debug }));
    },
  };
}

export default defineConfig({ plugins: [react(), jevProxy()] });
