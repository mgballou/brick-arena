import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { standInChoice } from './stand-in';
import { STAND_IN_MARK } from './wire';

// A stand-in for Jev on localhost, for playing the web game in debug mode with
// no key and no network. It answers POST /v1/systemone in the documented Choice
// shape, plus `answered_by: "stand-in"` so nothing downstream mistakes it for
// Jev: `landing` for a target ask, otherwise the first key offered, after a
// deterministic 250-550 ms, or after exactly `ms` when given. It never reads or
// logs a request header. Port 0 picks a free port.
export function startStandIn(options: { port?: number; ms?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  let calls = 0;
  const server = createServer((req, res) => {
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
        res.end(JSON.stringify({ model: request.model, answers: { decision: { type: 'choice', choice } }, ...STAND_IN_MARK }));
      }, options.ms ?? 250 + (calls * 97) % 300);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 18787, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}
