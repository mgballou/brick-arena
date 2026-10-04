import { createServer } from 'node:http';
import { hostedApp, hostedFromEnv } from '../packages/server/src/serve.ts';
import { DEPLOYED_KEY, DEPLOYED_URL, FAKE_TYPESAFE_PORT, OUT } from './servers.ts';

// The hosted server as Render starts it, over the e2e copy of Render's build
// (e2e/.out/render-dist): the options serve.ts builds from the host's
// environment, debug off. The environment is written here in full, so no outer
// one adds to it: a dummy JEV_API_KEY, and TypeSafe at the fake that
// deployed.e2e.ts runs, so no call leaves the machine.
const env = {
  JEV_API_KEY: DEPLOYED_KEY,
  JEV_BASE_URL: `http://127.0.0.1:${FAKE_TYPESAFE_PORT}`,
  MATCHES_DIR: `${OUT}/deployed-matches`,
};
createServer(hostedApp(await hostedFromEnv(env, `${OUT}/render-dist`)))
  .listen(Number(new URL(DEPLOYED_URL).port), '127.0.0.1', () => console.log(`e2e deployed server on ${DEPLOYED_URL}`));
