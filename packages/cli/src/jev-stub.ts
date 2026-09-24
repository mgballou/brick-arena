import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { standInChoice } from '../../jev/src/stand-in.ts';

// A stand-in for Jev on localhost, for playing the web game with no key and no
// network. It answers POST /v1/systemone in the documented Choice shape: always
// `landing` for a target ask, otherwise the first key offered, after a
// deterministic 250-550 ms, or after exactly --ms when given. It never reads or
// logs a request header.
//
//   pnpm jev:stub            (or: pnpm jev:stub --ms 728, the latency live Jev measured)
//   JEV_KEY_FILE=<any file with a dummy token> JEV_BASE_URL=http://127.0.0.1:18787 pnpm dev
const { values } = parseArgs({ options: { port: { type: 'string', default: '18787' }, ms: { type: 'string' } } });
let calls = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    calls++;
    let request: { model?: string; questions?: { decision?: { criteria?: Record<string, unknown> } } } = {};
    try { request = JSON.parse(body || '{}'); } catch { /* answered below as an empty ask */ }
    const keys = Object.keys(request.questions?.decision?.criteria ?? {});
    const choice = standInChoice(keys);
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: request.model, answers: { decision: { type: 'choice', choice } } }));
    }, values.ms === undefined ? 250 + (calls * 97) % 300 : Number(values.ms));
  });
}).listen(Number(values.port), '127.0.0.1', () => console.log(`Jev stub on http://127.0.0.1:${values.port} (not Jev: it always picks landing)`));
