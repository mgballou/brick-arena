import { createServer } from 'node:http';
import { CAP_DEFAULTS, createCap } from '../packages/jev/src/cap.ts';
import { JEV_DEFAULTS } from '../packages/jev/src/key.ts';
import { hostedApp } from '../packages/server/src/serve.ts';
import { createMatchStore } from '../packages/server/src/matches.ts';
import { HOSTED_URL, OUT } from './servers.ts';

// The hosted server's app over the e2e build (e2e/.out/dist), with the key
// empty in code rather than read from JEV_API_KEY, so no environment can hand
// it one. Every visitor sees the down page.
const link = { baseUrl: JEV_DEFAULTS.baseUrl, model: JEV_DEFAULTS.model, key: '' };
createServer(hostedApp({ dist: `${OUT}/dist`, proxy: { link, keyFrom: 'nowhere (e2e)', debug: false, cap: createCap(CAP_DEFAULTS) }, matches: createMatchStore(`${OUT}/hosted-matches`), admin: null }))
  .listen(Number(new URL(HOSTED_URL).port), '127.0.0.1', () => console.log(`e2e hosted server on ${HOSTED_URL}`));
