import { parseArgs } from 'node:util';
import { startStandIn } from '../../jev/src/stand-in-server.ts';

// The stand-in on localhost (see stand-in-server.ts). The game plays it only in
// debug mode, with a DEBUG banner on screen:
//
//   pnpm jev:stub            (or: pnpm jev:stub --ms 728, the latency live Jev measured)
//   VITE_DEBUG=1 JEV_KEY_FILE=<any file with a dummy token> JEV_BASE_URL=http://127.0.0.1:18787 pnpm dev
const { values } = parseArgs({ options: { port: { type: 'string', default: '18787' }, ms: { type: 'string' } } });
const { url } = await startStandIn({ port: Number(values.port), ms: values.ms === undefined ? undefined : Number(values.ms) });
console.log(`Jev stand-in on ${url} (not Jev: it aims every catch at the densest bricks, and the game plays it only with VITE_DEBUG=1)`);
